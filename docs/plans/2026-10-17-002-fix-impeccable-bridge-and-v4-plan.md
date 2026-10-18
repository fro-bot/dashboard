---
title: "fix: Harden the OpenCode Impeccable bridge and move Impeccable to v4"
type: fix
status: active
date: 2026-10-17
---

# fix: Harden the OpenCode Impeccable bridge and move Impeccable to v4

## Overview

The work lands in two stages, as separate PRs.

- **Stage A** hardens the local OpenCode Impeccable bridge. The hook subprocess is killed on timeout, and every degraded outcome warns instead of looking like a clean scan. Stage A closes #193 and does not depend on v4.
- **Stage B** moves the vendored Impeccable skill and the CI Design Check detector to the same v4 version.
  1. A detector spike can run at any time. It gates everything after it.
  2. The Design Check step is rewritten so it handles both 3.x and 4.x exit codes.
  3. Any fixes the spike calls for land next.
  4. The vendored skill is refreshed.
  5. Marcus approves Renovate's existing v4 branch.

Renovate owns the CI pin, and no unit edits it by hand.

## Problem Frame

Fro Bot's triage on #598 compares this repo's bridge with the hardened bridge in `marcusrbrown/marcusrbrown.github.io`. Renovate tracks the Design Check pin, which is on 3.6.1. `AGENTS.md` carries no pin. #193 is the triage's timeout item.

The bridge in `.opencode/impeccable/` has these defects:

- **Timeout.** `withTimeout` races the hook promise but never kills the child, so a timed-out scan is silent and looks like a clean one.
- **Output.** Raw stdout can reach the agent when the envelope is malformed. Stderr is surfaced verbatim. Output size is unbounded.
- **Environment.** An inherited hook-depth env var silently turns `hook.mjs` into a no-op.
- **Renames.** The destination of an `apply_patch` rename is never scanned.

These break the advisory, fail-loud contract in `docs/brainstorms/2026-07-10-opencode-impeccable-plugin-requirements.md` (R6, R11, AE6).

The v4 detector uses these exit codes for `detect`: 0 clean, 1 target not scannable, 2 findings. Under Actions `bash -e`, the current assignment `findings=$(npx … detect --json …)` fails the step on 1 or 2 before anything prints. Moving the pin before the step is rewritten turns `main` red with no readable output.

## Requirements Trace

**Stage A: bridge**

- R1. A timed-out hook subprocess is terminated with SIGTERM, then SIGKILL after a grace period. The tool call never waits past a bounded deadline.
- R2. Each degraded outcome warns in the tool result. The outcomes are:
  - timeout;
  - spawn failure;
  - nonzero exit;
  - exit 0 with stderr;
  - malformed output (bad JSON, wrong event, missing or empty `additionalContext`);
  - oversized output;
  - no extractable path on a built-in `edit`, `write` or `apply_patch` call, or on a tool whose args carry a path-like key.

  Exit 0 with empty stdout and empty stderr is a clean scan and stays silent.
- R3. The agent sees only parsed PostToolUse feedback. Raw stdout and stderr never reach it.
- R4. Inherited `IMPECCABLE_HOOK_DEPTH` and `CLAUDE_HOOK_DEPTH` are removed from the child's env, and the bridge never sets them.
- R5. `apply_patch` scans the add and update paths and the rename destination.
- R6. The bridge stays advisory. It never blocks a tool call or throws from one, and `plugin.ts` exports only the plugin factory.

**Stage B: v4**

- R7. The Design Check prints its findings and fails on scan failure, on findings, and on a non-empty primary findings array, under both 3.x and 4.x.
- R8. The vendored skill and the CI detector run the same Impeccable version, and Renovate moves the CI pin.
- R9. `.impeccable/config.json` changes only through scoped `ignoreValues` entries for intentional brand tokens.

## Scope Boundaries

- No v4 Stop-hook deep pass on `session.idle`.
- Other repositories (`mothership`, `.io`) are not changed.
- The gitignored, OpenCode-generated `.opencode/package.json` and its lockfile are not changed.
- No host-log channel (`client.app.log`). The warning in the tool result is the only signal.
- `hook-before-edit.mjs` stays unwired, because it can block writes.

## Context & Research

### Relevant Code and Patterns

- `.opencode/impeccable/plugin.ts` runs the hook through Bun `$`. It spreads `process.env` unscrubbed and does not bound output.
- `.opencode/impeccable/hook-bridge.ts` holds:
  - `withTimeout` and its silent-timeout branch;
  - stderr surfacing;
  - the raw-stdout fallback in feedback extraction;
  - the silent no-path return;
  - raw `apply_patch` handling.
- `.opencode/impeccable/plugin.test.ts` uses the `fakeRunner` pattern. Six tests pin behavior that changes:
  - the timeout no-op;
  - three raw-fallback extraction cases (non-JSON text, a bare JSON string, JSON without a recognized field);
  - the top-level and snake_case `additionalContext` cases.
- The port source is the `.io` bridge at `8a1567dfe`. Its `.opencode/impeccable/hook-bridge.ts` holds:
  - `createSpawnRunner` (depth scrub, 1 MiB UTF-8-safe cap, SIGTERM → 2000 ms grace → SIGKILL → resolve on `close`);
  - the strict extraction;
  - the Move-to markers;
  - the quiet-clean outcome table.

  Its `hook-bridge.integration.test.ts` has 21 real-child tests, with a 1000 ms SIGKILL budget.
- `vitest.config.ts` includes `.opencode/impeccable/**`. `bun run test` runs Vitest on Node. ESLint ignores `.opencode/**`.
- The Design Check step is in `.github/workflows/main.yaml`. Renovate tracks its `npx impeccable@<version>` line through the shared `bfra-me/renovate-config` npx regex, so the line keeps its shape.
- The vendored skill lives in `.agents/skills/impeccable/` (3.9.1). The bridge spawns `scripts/hook.mjs` from it.

### Institutional Learnings

- `docs/solutions/workflow-issues/opencode-plugin-hooks-need-live-verification-2026-07-10.md`:
  - the plugin module has one runtime export;
  - never set the depth env var;
  - surface only parsed feedback;
  - restart OpenCode and verify live.
- `docs/solutions/workflow-issues/impeccable-skill-shared-agents-install-2026-06-25.md`:
  - install the skill once under `.agents/skills/` with `--providers=agents --scope=project`;
  - the skill and the detector are separate changes with separate verification;
  - keep `PRODUCT.md`, `DESIGN.md` and the intentional config allowances.
- `docs/solutions/workflow-issues/unit-green-is-not-feature-done-verify-the-assembled-surface-2026-06-23.md`: verify the assembled surface.

### External References

- Impeccable 4.x CLI README, for exit codes, the `--json` array and `detector.ignoreValues`: https://github.com/pbakaus/impeccable/blob/main/README.npm.md
- Impeccable 4.0.0 skill release notes, for rule additions, the staleness check and `doctor`: https://github.com/pbakaus/impeccable/releases/tag/skill-v4.0.0

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": ".opencode/impeccable/ and .agents/skills/impeccable/scripts/ in fro-bot/dashboard",
  "freshness": {
    "vcs_reference": "a3286b1"
  },
  "budget": {
    "max_search_passes": 2,
    "max_candidate_inspections": 4,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": ".opencode/impeccable/hook-bridge.ts",
      "description": "Owns hook invocation, timeout, feedback extraction, path extraction and warn-once for the OpenCode bridge",
      "disposition": "extend"
    },
    {
      "path_or_symbol": ".opencode/impeccable/plugin.ts",
      "description": "Plugin factory and the Bun $ runner that the spawn runner replaces",
      "disposition": "extend"
    },
    {
      "path_or_symbol": ".agents/skills/impeccable/scripts/hook.mjs",
      "description": "Vendored Impeccable PostToolUse hook the bridge spawns; reused unchanged",
      "disposition": "reuse"
    }
  ]
}
```

## Key Technical Decisions

- **Runner: Node `child_process.spawn`, ported from `.io`.** Unlike Bun `$`, it can be tested under Vitest on Node. It spawns a literal `node` with no shell.
- **Timing: 5000 ms timeout, then a 2000 ms grace before SIGKILL, with a final deadline just after timeout plus grace.** The runner resolves on `close`, or at the final deadline if a child keeps its pipes open. A tool call therefore never waits much longer than 7 s.
- **Result shape: discriminated, with a distinct message per kind.** The kinds are `ok`, `timeout`, `spawn-error`, `nonzero-exit` and `overflow`. The bridge adds `stderr-on-clean`, `malformed`, `no-path` and `bridge-error`. All extraction failures share the `malformed` kind. A runner rejection or a fault in the bridge itself is `bridge-error`, not `spawn-error`. A warning names its kind and never includes stderr.
- **Warn once per kind per plugin instance.** A timeout that follows an earlier warning of another kind still shows. A non-string `output.output` is never modified.
- **Clean scan: exit 0 with empty stdout and empty stderr, which matches `.io`.** A `hook-lib` crash that exits 0 and writes nothing looks the same at runtime. The canary integration test guards it, and this is an accepted risk.
- **The no-path warning applies only to built-in `edit`, `write` and `apply_patch`, and to tools whose args carry a path-like key.** Path-less MCP `*_edit` calls stay silent.
- **Stage B order: spike, step rewrite, spike fixes, skill, Renovate.**
  - The step rewrite works on 3.6.1 and 4.x. The `npx impeccable@<version>` literal keeps its own line.
  - The skill is installed at the version on Renovate's `renovate/impeccable-4.x` branch at that point.
  - Marcus ticks the v4 checkbox on Dependency Dashboard #8. Renovate then regenerates the branch from main, and its PR has to pass the Design Check.
- **Spike outcome: go or hold.**
  - On go: genuine anti-patterns are fixed in the spike-fixes PR, and an intentional brand token gets a scoped `ignoreValues` entry in the same PR.
  - On hold: the detector is unusable, because it rejects the config or its exit codes or output can't be used. The step rewrite still lands, since it works on 3.x. Spike fixes, the skill refresh and the approval stop, and the skill stays on 3.x.
- **Skew window accepted.** Between the skill-refresh merge and the Renovate merge, main runs the v4 skill with the 3.6.1 detector. If the Renovate PR head's version differs from the vendored skill, Unit 7 reruns at the PR head's version before approval.
- **Orphaned children are an accepted risk.** The deadline bounds a child only while the plugin process lives. If OpenCode exits mid-scan, the child can outlive it. `hook.mjs` spawns nothing, so the exposure is one short-lived process.

## Open Questions

### Resolved During Planning

- Marcus decided: the timeout warns; the Node spawn runner; Stage A separate from Stage B; the Stage B order; the spike outcome rules; the skew window.
- `.opencode/package.json` version drift is out of scope, because OpenCode generates and gitignores that file.

### Deferred to Implementation

- **Spike results.** For each version, capture the exit code on findings and on scan failure (3.6.1 and 4.x), whether advisories appear in the `--json` array, whether `ignoreValues` is honored, any new findings, and stderr on a clean run. Unit 6's handling of advisories and of the 3.x exit codes depends on these.
- **The v4 `hook.mjs` contract.** Check that stdin fields, stdout envelope, env vars and stderr on a clean run still match the bridge, against the installed bundle.
- **Installer flags.** Use `--help` to check whether `--providers=agents` and the `skills install` namespace still work at the target version.

## Implementation Units

### Stage A: bridge hardening (PR 1, closes #193)

- [x] **Unit 1: Spawn runner with a bounded deadline**

**Goal:** Replace the Bun `$` runner with a Node spawn runner that owns the timeout and bounds the tool call.

**Requirements:** R1, R4, R6

**Dependencies:** None

**Files:**
- Modify: `.opencode/impeccable/hook-bridge.ts`
- Modify: `.opencode/impeccable/plugin.ts`
- Create: `.opencode/impeccable/hook-bridge.integration.test.ts`
- Test: `.opencode/impeccable/plugin.test.ts`

**Approach:**
- Port `createSpawnRunner` into `hook-bridge.ts`, adding the final deadline and the discriminated result.
- Remove `withTimeout` from `createHook`, and remove the runner from `plugin.ts`. `plugin.ts` keeps exactly one export.
- The child gets the inherited env minus both depth variables.

**Execution note:** Test-first. Port the whole `.io` integration suite. Flip the timeout no-op test in `plugin.test.ts`. Then confirm all of it fails red against the current bridge.

**Patterns to follow:**
- `.io` `createSpawnRunner` and `hook-bridge.integration.test.ts`.
- `fakeRunner` in `plugin.test.ts`, for unit cases.

**Test scenarios:**
- Happy path: a child that writes a valid envelope and exits 0 resolves `ok` with its stdout.
- Error path: a child that ignores SIGTERM is SIGKILLed after the grace period and resolves `timeout`. Afterwards, `process.kill(pid, 0)` throws (1000 ms budget beyond the grace period).
- Edge case: a child that exits during the grace period resolves `timeout` without being SIGKILLed.
- Edge case: a child that exits 0 but keeps stdout open resolves `timeout` at the final deadline.
- Error path: a missing `node` binary or script resolves `spawn-error` and does not throw.
- Edge case: inherited `IMPECCABLE_HOOK_DEPTH` and `CLAUDE_HOOK_DEPTH` are absent from the child's env.
- Integration: the real vendored `hook.mjs`, run on a fixture file with a known anti-pattern, returns an envelope containing that finding. This is the canary for a `hook-lib` crash.
- Integration: `plugin.ts` exposes exactly one runtime export.

**Verification:**
- The integration suite reaps every child.
- The canary passes against the vendored `hook.mjs`.

- [x] **Unit 2: Strict output handling and warnings per kind**

**Goal:** Only parsed feedback reaches the agent, and each degraded outcome warns once per kind.

**Requirements:** R2, R3, R6

**Dependencies:** Unit 1

**Files:**
- Modify: `.opencode/impeccable/hook-bridge.ts`
- Test: `.opencode/impeccable/plugin.test.ts`
- Test: `.opencode/impeccable/hook-bridge.integration.test.ts`

**Approach:**
- Cap output at 1 MiB with UTF-8-safe truncation. Overflow is the `overflow` kind.
- Extraction accepts only `hookSpecificOutput.hookEventName === 'PostToolUse'` with a non-empty `additionalContext`. Anything else is `malformed`.
- Exit 0 with stderr is `stderr-on-clean`. A nonzero exit is `nonzero-exit` and gets a generic message. Stderr never appears.
- Keep warnings in a set keyed by kind.

**Execution note:** Flip the five extraction tests that pin raw-fallback and top-level or snake_case behavior, and watch them fail first.

**Test scenarios:**
- Happy path: a valid envelope appends only its `additionalContext`.
- Happy path: exit 0 with empty stdout and empty stderr stays silent.
- Error path: malformed JSON, a wrong `hookEventName` and an empty `additionalContext` all share the `malformed` kind. The first warns, later ones are silent, and no raw text is appended.
- Error path: exit 0 with empty stdout and non-empty stderr warns `stderr-on-clean` without the stderr text.
- Error path: a nonzero exit with stderr warns, and the stderr text is not in the output.
- Error path: output over 1 MiB warns `overflow` and appends no partial envelope.
- Edge case: a timeout after an earlier `malformed` warning still warns. A second timeout does not.
- Edge case: a non-string `output.output` is left untouched.
- Edge case: a multi-byte character split at the cap boundary does not produce an invalid string.

**Verification:**
- No test output contains raw stdout or stderr.
- Each kind warns once.

- [x] **Unit 3: Rename destinations and no-path warnings**

**Goal:** Scan rename destinations, and warn when a file-mutating tool yields no path.

**Requirements:** R2, R5

**Dependencies:** Unit 2

**Files:**
- Modify: `.opencode/impeccable/hook-bridge.ts`
- Test: `.opencode/impeccable/plugin.test.ts`
- Test: `.opencode/impeccable/hook-bridge.integration.test.ts`

**Approach:**
- Port `withMoveToScanMarkers`. It appends a synthetic `*** Update File: <dest>` for each `*** Move to:` line.
- Warn `no-path` only for built-in `edit`, `write` and `apply_patch`, and for tools whose args carry a path-like key.

**Test scenarios:**
- Happy path: an `apply_patch` that renames `a.tsx` to `b.tsx` sends the patch with an Update marker for `b.tsx`.
- Happy path: an `apply_patch` that adds, updates and deletes files passes through unchanged apart from rename markers.
- Edge case: an MCP `foo_edit` with no path-like arg stays silent.
- Error path: a built-in `edit` with no `filePath` warns once.
- Edge case: absolute and relative paths reach `hook.mjs` as given. Paths outside the worktree pass through, and `hook.mjs` filters them.
- Integration: the vendored `hook.mjs` scans a rename destination.

**Verification:**
- The rename destination is scanned by the real hook.

- [x] **Unit 4: Live verification and docs**

**Goal:** Prove the assembled plugin works in a real OpenCode session, and bring the docs in line with the current design.

**Requirements:** R1–R6

**Dependencies:** Units 1–3

**Files:**
- Modify: `docs/solutions/workflow-issues/opencode-plugin-hooks-need-live-verification-2026-07-10.md`
- Modify: `docs/plans/2026-07-10-001-feat-opencode-impeccable-plugin-plan.md`

**Approach:**
- Restart OpenCode and confirm from the host log that the plugin loaded. Then exercise:
  - `edit` and `write` on a file with a known finding;
  - a clean edit;
  - an `apply_patch` rename;
  - an MCP `*_edit`;
  - a burst of parallel edits.
- In a scratch copy, use a `hook.mjs` that ignores SIGTERM to check the timeout path: the warning shows once, and no child is left behind. Production code gets no test seam.
- Rewrite the runner, timeout and depth-guard statements in both docs so they state the current decision only.

**Test expectation:** none. This unit is verification and docs only.

**Verification:**
- The transcript shows the finding, a silent clean run, the scanned rename destination and one timeout warning.
- `ps` shows no surviving hook child.

### Stage B: v4 move (PRs 2–4, then the Renovate PR)

- [x] **Unit 5: Detector spike**

**Goal:** Decide from data whether v4 can be used on this tree, and how the step has to treat its output.

**Requirements:** R7, R8, R9

**Dependencies:** None. It can run alongside Stage A, and it gates Units 6–8.

**Files:** none. Record the results in the Unit 6 PR description.

**Approach:**
- Run the CI command with 3.6.1, the version on Renovate's branch, and npm `latest`, against the unchanged `.impeccable/config.json`.
- For each version, record:
  - the exit code on a clean tree, on a findings fixture and on an unscannable target;
  - the stdout array, and whether advisories appear in it;
  - whether `bounce-easing` `ignoreValues` is honored;
  - new findings;
  - stderr on a clean run.
- Decide go or hold under the spike outcome rules.

**Test expectation:** none. This is an investigation.

**Verification:**
- Each version has a recorded exit code and findings set for each input.
- A go or hold decision is recorded.

- [ ] **Unit 6: Exit-code-safe Design Check step**

**Goal:** The Design Check prints findings and fails correctly on 3.x and 4.x.

**Requirements:** R7

**Dependencies:** Unit 5

**Files:**
- Modify: `.github/workflows/main.yaml`

**Approach:**
- Capture stdout and the exit code without `bash -e` aborting the assignment.
- Print the findings whenever they are non-empty or the exit is nonzero.
- Fail on scan failure (printed distinctly), on findings, or on a non-empty primary findings array. Advisories and the 3.x exit codes are handled as Unit 5 recorded them.
- Keep the `npx impeccable@<version>` literal on its own line, in the same shape, so the Renovate regex still matches it.

**Test expectation:** none. The PR's own Design Check exercises the step on 3.6.1.

**Verification:**
- actionlint passes.
- The Design Check passes on 3.6.1.
- Run locally, the step script prints and fails on a findings fixture and on an unscannable input, under both 3.6.1 and 4.x. A clean tree passes under both.
- Renovate's dashboard still lists the `impeccable` dependency after merge.

- [ ] **Unit 6b: Spike fixes**

**Goal:** Remove every genuine v4 finding before the pin moves.

**Requirements:** R7, R9

**Dependencies:** Unit 5 decided go

**Files:**
- Modify: the files under `web/src/` or `web/privacy.html` that Unit 5 flagged
- Modify: `.impeccable/config.json` (scoped `ignoreValues` entries only)

**Approach:**
- Fix genuine anti-patterns in code.
- Add a scoped `ignoreValues` entry only for an intentional brand token, the way `bounce-easing` is handled.
- If Unit 5 recorded no genuine findings, this unit is a no-op and is marked done.

**Test expectation:** none. The gate is the v4 detector. UI changes need a screenshot check.

**Verification:**
- The v4 detector, run locally with this branch's config, returns an empty primary findings array.
- The 3.6.1 Design Check still passes.

- [ ] **Unit 7: Vendored skill refresh**

**Goal:** Install the skill at the version on Renovate's v4 branch, and confirm the bridge contract still holds.

**Requirements:** R8, R9

**Dependencies:** Stage A merged, Unit 6 merged, Unit 6b merged

**Files:**
- Modify: `.agents/skills/impeccable/**` (installer output)
- Test: `.opencode/impeccable/hook-bridge.integration.test.ts`

**Approach:**
- Read the version from the current Renovate branch head. Check `--help` for the install command and the `agents` provider before running the installer.
- The installer must leave `.impeccable/config.json` unchanged. Review the full `git status`. Revert any change to another harness's hook config, and any wiring of `hook-before-edit.mjs` or the Stop hook.
- Check the v4 `hook.mjs` against the bridge: stdin fields, stdout envelope, harness, quiet and depth env vars, `apply_patch` Move-to parsing, and stderr on a clean run. Adapt the bridge only where the contract changed.

**Test scenarios:**
- Integration: the Unit 1 canary passes against the v4 `hook.mjs`.
- Integration: the Unit 3 rename-destination case passes against the v4 `hook.mjs`.
- Integration: a clean scan with the v4 `hook.mjs` stays silent.

**Verification:**
- The integration suite passes on the v4 bundle.
- `.impeccable/config.json` is unchanged by the installer.
- Repeat the Unit 4 live checks on the refreshed skill.

- [ ] **Unit 8: Approve the Renovate v4 branch**

**Goal:** Move the CI detector to the skill's version through Renovate.

**Requirements:** R8

**Dependencies:** Unit 7 merged

**Files:** none. Renovate's PR changes `.github/workflows/main.yaml`.

**Approach:**
- Marcus ticks the v4 checkbox on Dependency Dashboard #8. Renovate regenerates the branch from main.
- Confirm the PR diff changes only the version literal.
- Confirm the PR head's version matches the vendored skill. If it does not, rerun Unit 7 at that version first.

**Test expectation:** none. The gate is the PR's own Design Check.

**Verification:**
- The Renovate PR passes the Design Check.
- Its version equals the vendored skill version.

## System-Wide Impact

- **Interaction graph:** Every OpenCode `edit`, `write` and `apply_patch` call runs the bridge. A failure never changes the tool's own result. It can only append a warning.
- **Error propagation:** Runner and extraction failures each become one warning per kind. Nothing throws into OpenCode.
- **Unchanged invariants:**
  - `IMPECCABLE_HOOK_HARNESS=claude` and `IMPECCABLE_HOOK_QUIET=1` keep their current behavior.
  - `.github/hooks/impeccable.json` is unchanged.
  - Renovate owns the CI pin.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| A `hook-lib` crash that exits 0 with no output looks like a clean scan | The canary integration test runs the real hook on a known finding |
| The v4 `hook.mjs` contract changed and the docs don't say so | Unit 7 checks the installed bundle. The canary and rename tests run the real script |
| Renovate retargets from 4.5.2 to 4.6.0 between the spike and the approval | Unit 7 reads the version from the branch head. Unit 8 reruns Unit 7 if the PR head differs |
| The installer rewrites config or wires a hook that can block | Unit 7 requires an unchanged config and a reviewed `git status` |
| v4 writes stderr on clean runs, so every edit warns | Unit 5 records stderr on a clean run. Unit 7 adapts the bridge |
| Vitest runs on Node while OpenCode loads plugins under Bun | Live verification in Units 4 and 7 |
| The v4 pin breaks main after merge | Revert the Renovate PR. The pin returns to 3.6.1 |

## Sources & References

- Related issues: #598, #193
- Fro Bot triage: https://github.com/fro-bot/dashboard/issues/598
- Prior plan: `docs/plans/2026-07-10-001-feat-opencode-impeccable-plugin-plan.md`
- Bridge requirements: `docs/brainstorms/2026-07-10-opencode-impeccable-plugin-requirements.md`
