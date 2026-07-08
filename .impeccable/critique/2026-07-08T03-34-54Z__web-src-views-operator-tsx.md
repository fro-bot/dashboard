---
target: web/src/views/Operator.tsx
total_score: 24
p0_count: 0
p1_count: 2
timestamp: 2026-07-08T03-34-54Z
slug: web-src-views-operator-tsx
---

# Design Critique: Operator Failure-Reason UI Feature

Target: `web/src/views/Operator.tsx` (with `web/src/index.css` and `public/operator-*.js`)

## Design Health Score

| #         | Heuristic                       | Score     | Key Issue                                                                                                                  |
| --------- | ------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1         | Visibility of System Status     | 3         | Timely updates via SSE streams, but unknown terminal failures collapse to generic states with no context.                  |
| 2         | Match System / Real World       | 3         | Technical terminology is precise, but raw database codes occasionally leak into client mappings.                           |
| 3         | User Control and Freedom        | 2         | No inline retry, relaunch, or rollback controls linked to specific run failure reasons.                                    |
| 4         | Consistency and Standards       | 2         | High visual variance in warning borders (double, dashed, dotted); use of cartoonish system emojis instead of vector icons. |
| 5         | Error Prevention                | 3         | Scenario selector is an excellent development harness; launch drawer blocks invalid prompts.                               |
| 6         | Recognition Rather Than Recall  | 3         | Failure reasons displayed on cards, but impaired by severe contrast issues.                                                |
| 7         | Flexibility and Efficiency      | 2         | No keyboard accelerators to navigate, select, or re-run active/failed operator instances.                                  |
| 8         | Aesthetic and Minimalist Design | 3         | Beautiful void theme, but grid layout precision is broken when failure reasons wrap in column 1.                           |
| 9         | Error Recovery                  | 2         | Displays clear descriptive labels, but lacks constructive next steps or troubleshooting hints for runs.                    |
| 10        | Help and Documentation          | 1         | No tooltips or contextual documentation on what specific failures mean or how to resolve them.                             |
| **Total** |                                 | **24/40** | **Acceptable** (Significant improvements needed)                                                                           |

---

## Anti-Patterns Verdict

_Does this look AI-generated?_

**LLM Assessment**: **CLEAN WITH RESERVATIONS**.
The core codebase is extremely bespoke, secure, and rigorously engineered. The custom DOM-diffing logic and SSE state-machine in `public/operator-stream.js` and `public/operator-run-index.js` show high human craft. However, the visual presentation of states in `web/src/index.css` exhibits classic "AI-assistant" scaffolding traits. Specifically, the "kitchen-sink" border treatments (double vs dashed vs dotted borders for warning states) and the reliance on cartoonish, system-default emojis (`🔑`, `⏳`, `📡`, `⚠️`) injected via CSS represent a visual mismatch with the premium cyberpunk/Afrofuturism brand identity.

**Deterministic Scan**: **SKIPPED** (Independent assessment requested).

**Visual Overlays**: **UNAVAILABLE** (Read-only critique run, browser overlay skipped).

---

## Overall Impression

The operator failure-reason feature is exceptionally robust under the hood, but the visual execution undermines its technical credibility. It suffers from a few common product UI traps: low-contrast typography, awkward grid wrapping on dense content, and arbitrary stylistic decorative variance. The biggest opportunity is to align the presentation of failure states with the cyber-technical precision of the streaming reducer.

---

## What's Working

1. **Robust Core Reducer & Diffing Logic**: The SSE frame parser in `public/operator-stream.js` and the in-place DOM reconciliation in `public/operator-run-index.js` are outstanding. They manage optimistic launches, terminal freezes, and secure boundaries flawlessly.
2. **Branded Color Cohesion (Dark-Default)**: The usage of `--color-bg` (#0d0216 void) and `--color-surface` (#1a0b2e) establishes a beautiful, immersive, and highly thematic environment that feels organic to the Fro Bot identity.
3. **Graceful Error Recovery Hints**: The global operator shell handles disconnected states gracefully with distinct status headlines and clear recovery hints.

---

## Priority Issues

### `P1` — Insufficient Contrast on Failure Reasons (`.run-reason`)

- **Why it matters**: In dark mode, `.run-reason` uses `--color-text-subtle` (`rgba(245, 235, 235, 0.5)`) on `--color-bg` (`#0d0216`), yielding a contrast ratio of **4.3:1**. In light mode, it uses `rgba(26, 11, 46, 0.45)` on white (`#ffffff`), yielding an abysmal **3.0:1** contrast. Both violate WCAG AA requirements (4.5:1 minimum) and make diagnostic failure text completely illegible for many operators.
- **Fix**: Promote `.run-reason` to `--color-text-muted` (`#f5ebeb` in dark, `#5c4569` in light) to guarantee a contrast ratio ≥4.5:1.
- **Suggested command**: `$impeccable polish`

### `P1` — Visual Inconsistencies & Clashing Emojis in Warning Panels

- **Why it matters**: `.operator-warning-panel` styles use cartoonish system emojis (`🔑`, `⏳`, `📡`, `⚠️`) injected via CSS `::before`, combined with four different border styles (double, dashed, dotted, solid). This looks chaotic, amateurish, and clashes heavily with the refined cyber-technical identity ("machine precision").
- **Fix**: Standardize on a solid 1px border. Replace default OS emojis with inline monochrome SVG icons or technical unicode symbols (`▲`, `◆`, `▼`).
- **Suggested command**: `$impeccable quieter`

### `P2` — Grid Alignment & Layout Shattering on Wrapping

- **Why it matters**: `.run-card` is a 3-column grid (`auto 1fr auto`). Placing `.run-reason` inside the first column alongside the status badge causes the badge and the reason text to wrap inside `.run-status-group`. This balloons the card height and breaks vertical alignment with the repository and timestamp columns, ruining the dashboard's "machine precision" aesthetic.
- **Fix**: Move `.run-reason` out of `.run-status-group` and position it in column 2, directly beneath `.run-repo` as a block-level subtitle. This creates a clean spatial hierarchy:
  - **Column 1**: Fixed-width status badge (e.g., `Failed`)
  - **Column 2**: Repository title + Failure reason subtitle (e.g., `Workspace unavailable`)
  - **Column 3**: Timestamp
- **Suggested command**: `$impeccable layout`

### `P2` — Missing Actionable Controls on Failure State

- **Why it matters**: When a run terminates with a failure reason (e.g., "Workspace unavailable" or "No recent activity"), the operator has no contextual actions (such as "Rerun" or "Troubleshoot"). They must manually go back and launch a brand new run from scratch, increasing friction.
- **Fix**: Introduce a small secondary inline "Retry" or "Debug" action on the run card when expanded or hovered in a terminal failure state.
- **Suggested command**: `$impeccable shape`

---

## Persona Red Flags

### **Sam (Accessibility-Dependent User)**

- **Red Flags**:
  - **Color Contrast Failures**: Sam cannot read the failure reasons (e.g., "Run timed out") because they resolve to a **3.0:1** contrast ratio in light mode and **4.3:1** in dark mode.
  - **Screen Reader Redundancy**: The `aria-label` generated on the card (lines 601-604 of `operator-run-index.js`) duplicates the internal text structure exactly, causing the screen reader to announce "Run, status: Failed, reason: Workspace unavailable" and then immediately announce the status badge, the reason, the repo, and the timestamp, causing heavy cognitive fatigue.

### **Alex (Power User)**

- **Red Flags**:
  - **No Keyboard Accelerators**: Alex cannot navigate between run cards using Arrow keys or open the expanded output using keyboard shortcuts.
  - **Absence of Bulk Actions**: If multiple runs fail, there is no way to bulk-clear, bulk-retry, or filter the index to show _only_ failed runs.

### **Jordan (First-Timer)**

- **Red Flags**:
  - **Technical Jargon Collapsing**: When a run fails with `unknown` or a contract mismatch, the UI collapses to a generic `Failed` status with no description of how to resolve the problem.
  - **Cryptic Error Code Leaks**: If a connection fails during launch, the error handling (line 418 in `Operator.tsx`) exposes a bare string block without actionable recovery steps.

---

## Minor Observations

1. **Scenarios List Overload**: The scenario selector in the launch drawer contains 10 distinct options. While useful for local testing, presenting 10 un-grouped choices violates the Cowan/Miller working memory threshold of ≤4 options.
2. **Animation Lack on Expansion**: Opening and closing the run details inside `.run-card` happens instantaneously without standard brand transitions (e.g. `--duration-fast` with `--ease-standard`). It feels abrupt compared to the rest of the application shell.
3. **Hardcoded CSS Colors**: The styling for `.run-status.status-failed` uses hardcoded RGBA values (`rgba(244, 67, 54, 0.1)`) instead of tying into the semantic Tailwind 4 theme color variables (`--color-error`).
