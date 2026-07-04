---
date: 2026-07-03
topic: operator-home-run-centric-redesign
---

# Operator Home Run-Centric Redesign

## Summary

Redesign the operator home (`/`) from three stacked sections into one run-centric surface: a unified list of runs where active runs pin to the top, terminal runs sit below, and selecting a run expands it in place to show live output and approval prompts. Launch becomes a persistent "new run" affordance that drops a fresh active run you immediately observe. The whole surface moves onto Fro Bot brand tokens with real status language, loading skeletons, and mobile-first layout, executed through @designer + the Impeccable gate.

---

## Problem Frame

The operator surface shipped structurally but never got a design layer. The operator-first PWA plan (`docs/plans/2026-06-26-002-feat-operator-first-pwa-plan.md`) made `/` the operator app, deleted monitoring, and wired routing/failure-state/runtime plumbing — but its only UI requirements were accessibility and safe-text rendering. The visual design energy (count strips, urgency tiers, loading states) went into the monitoring surface, which that same plan then deleted. The operator surface inherited a bare functional skeleton.

The result is visible in production: Recent Runs renders as a flat, unlabeled text dump (`Failedmarcusrbrown/systematic2026-06-27T21:58:24.846Z` — status, repo, and timestamp concatenated into one text node with no columns or separation), there are no loading indicators, and the surface is three disconnected stacked sections (Recent Runs → Launch form → live Runs/stream). Nothing communicates run state at a glance, and the launch→observe→approve loop is fragmented across three regions instead of reading as one coherent object: a run.

---

## Actors

- A1. Operator (Marcus): the single authenticated human. Launches runs, observes live output, decides approvals. The surface is optimized entirely for this actor's launch→observe→approve loop.
- A2. Gateway: the same-origin session/run/stream authority. Owns run data, the SSE output channel, and approval transport. The dashboard consumes it browser-direct; it is never proxied.
- A3. Agent run output (untrusted): text streamed from an executing agent run. Attacker-influenceable — a hostile or compromised run can emit arbitrary text. This actor is why stream content rendering is a security boundary, not a formatting choice.

---

## Key Flows

- F1. Observe an existing run
  - **Trigger:** Operator opens `/` with prior/active runs present.
  - **Actors:** A1, A2, A3
  - **Steps:** Shell boots → run list loads (skeleton while pending) → active runs pinned top, terminal below → operator selects a run → row expands in place → live output streams into the expanded region; terminal runs show final output.
  - **Outcome:** Operator sees run state at a glance and drills into any run's output without leaving the list.
  - **Covered by:** R1, R2, R3, R4, R7, R8

- F2. Launch and observe a new run
  - **Trigger:** Operator triggers the persistent "new run" affordance.
  - **Actors:** A1, A2, A3
  - **Steps:** Operator opens the launch affordance → picks a repo, enters a prompt → submits → a new active run row appears pinned at top, already expanded → output streams in as the agent works.
  - **Outcome:** Launch converges directly into the same run object the operator then observes; no separate "launch" vs "runs" mental model.
  - **Covered by:** R5, R6, R7

- F3. Decide an approval on a live run
  - **Trigger:** A running, expanded run emits an approval prompt.
  - **Actors:** A1, A2, A3
  - **Steps:** Approval prompt renders inline in the expanded run → operator sees the requested action as inert text → decides once/always/reject → decision posts with CSRF+idempotency → prompt resolves in place.
  - **Outcome:** Approvals are handled within the run's expanded view, not a detached section.
  - **Covered by:** R8, R14

---

## Requirements

**Run-centric information architecture**
- R1. `/` renders one unified run list as the primary surface. The three separate sections (Recent Runs, Launch, live Runs/stream) are replaced by a single run-oriented component.
- R2. Active/in-flight runs pin to the top of the list; terminal runs (succeeded/failed/cancelled) sort below. Ordering within each group is most-recent-first. The list is a recent-runs window bounded by the existing run-index cap — it is presented as recent work, not the full run history, and does not claim exhaustive history it cannot supply.
- R3. Selecting a run expands it in place to reveal its detail (live or final output, and approval prompts when present). Collapsing returns to the compact row. At most one implementation-defined expansion model (single-open vs multi-open) — resolved in planning.
- R4. Each run row presents status, repo, and relative time as distinct, labeled, aligned fields — never concatenated text. Status uses a color+label language (e.g., running, queued, succeeded, failed, cancelled) driven by a fixed label map, not the raw wire string.

**Launch as a persistent affordance**
- R5. Launch is a persistent affordance (e.g., a top-bar action or "new run" control), not a standalone stacked panel. The dedicated Launch section is removed from the page body.
- R6. A successful launch inserts a new active run at the top of the list, already expanded for observation, and hands off to the same stream-observation path used by existing runs (one runtime owner; no double-mount).

**Live output and stream presentation**
- R7. The expanded run renders live agent output as it streams, and renders the final authoritative output for terminal runs. Output presentation is modern and readable (structured, not a flat monospace blob). An expanded run whose output is large stays usable — output has a bounded height with internal scroll and an explicit truncation affordance at the existing output cap, never runaway row height.
- R8. Approval prompts render inline within the expanded run, showing the requested action as inert text, with once/always/reject controls that preserve the existing CSRF + idempotency + one-retry behavior.

**States and feedback**
- R9. The list, each run's output, and the launch affordance show explicit loading states (skeletons or equivalent) while data is pending — no blank or flat-text placeholder.
- R10. Empty state (no runs) renders a purposeful, branded empty affordance that invites launching a run.
- R11. The existing four-state operator failure taxonomy (auth-required, rate-limited, offline, unavailable) is preserved and rendered with the redesigned visual language; no failure signal regresses to a flat/neutral dump that hides state.
- R11a. Reload is graceful ("reloadable" from the user's framing): a hard refresh restores the operator surface without a jarring blank flash, re-fetches live run state, and reconnects the stream for any run that was being observed. Whether the last-selected/expanded run is restored across refresh is a planning decision, but a refresh must never leave the surface stuck in a blank or partial state.

**Visual system and platform**
- R12. All operator surfaces use Fro Bot brand tokens (color, type scale, spacing, radius, motion) rather than ad-hoc inline styles. Inline per-element style objects give way to a coherent token-driven system.
- R13. The surface is mobile-first and responsive: the run list, expansion, launch affordance, and approvals are usable as a single column on a phone and scale up on desktop. Dark and light themes both hold.
- R14. The redesign passes the Impeccable design gate and preserves accessibility: headings, focus order, touch targets, and live-region announcements for state changes.

**Security invariants (preserved)**
- R15. Untrusted run output (stream/output/approval content) renders as inert text by default — no HTML interpolation. A richer renderer is adopted only if it provably disables raw HTML, allowlists no external link/image origins, blocks data-images and protocol handlers, and preserves inert rendering under a security-review gate with a malicious-markdown/HTML regression test. If that gate isn't cleanly met, the safe-DOM plain-text renderer is mandatory (hard requirement, not advisory).
- R16. The redesign runs under the current CSP (`script-src 'self'`) with no inline-script or eval requirement. Any renderer, syntax highlighter, or diagram library that would require relaxing CSP is disallowed.
- R17. The dashboard never becomes a Gateway proxy: all `/operator/*` run/session/stream/approval/launch calls stay browser-direct and same-origin; the no-dashboard-proxy 404 invariant holds.
- R18. No sensitive value — raw payloads, run IDs, repo names beyond the labeled safe field, tokens, cookies, CSRF values, endpoint paths — reaches rendered text, DOM attributes, link/image targets, prefetches, logs, caches, browser storage, or console. Renderer output is sanitized before any caching or logging.

---

## Acceptance Examples

- AE1. **Covers R2, R3.** Given a mix of one running and several terminal runs, when the list loads, then the running run appears pinned above the terminal runs, and selecting it expands its live output in place while the others stay collapsed.
- AE2. **Covers R4.** Given a failed run for `marcusrbrown/systematic`, when its row renders, then status ("Failed") repo, and relative time appear as separate labeled fields with a failure color — not as a single concatenated string.
- AE3. **Covers R6.** Given the operator submits a launch, when the Gateway accepts it, then a new active run row appears at the top already expanded, and its output streams through the same path as a pre-existing run (no duplicate stream, no separate launch result panel).
- AE4. **Covers R9, R10.** Given the run list is still loading, then a skeleton renders; given it resolves to zero runs, then a branded empty state invites launching a run.
- AE5. **Covers R11.** Given the operator session has expired, when the surface classifies auth-required, then the redesigned auth-required state renders with the new visual language and disables launch/approval actions — it does not fall back to a flat list dump.
- AE6. **Covers R15.** Given a run emits output containing markdown or HTML-like text, when it renders, then no active HTML/script/link-origin from that untrusted text executes or resolves — the content is shown safely.

---

## Success Criteria

- The operator opens `/` and understands run state at a glance: what's running now, what recently failed, and what succeeded — without parsing a text blob.
- The launch→observe→approve loop reads as one coherent object (a run), not three disconnected sections.
- A downstream planner can execute without inventing product behavior: the IA, the interaction model, state coverage, and the security boundary for output rendering are settled here; the remaining interaction-detail choices (expansion model, exact run-row anatomy, launch-affordance placement) are explicitly delegated to the design phase, not left as accidental gaps.
- No security invariant regresses: stream content stays injection-safe, the surface stays no-proxy, and no sensitive value leaks — provable by the existing and extended regression gates.
- The assembled surface is verified in a real browser against real run data (not fixtures) before it is called done.

---

## Scope Boundaries

- No new Gateway capabilities: no server-side run history, pagination, search, or filtering beyond the current run-index cap. This is a consumption-side redesign of existing contracts.
- No monitoring revival: the deleted monitoring surface is not brought back or blended in.
- Push notifications / background sync (`fro-bot/dashboard#108`) stay out.
- Dedicated infra App hardening (`fro-bot/dashboard#112`) stays out.
- No change to the Gateway operator auth model, session authority, or the browser-direct trust boundary — only how consumed data is presented.
- No offline queueing, optimistic run mutation, or persisted deferred actions.
- Failure-reason UI for inactivity/settlement remains gated on `fro-bot/agent#1099` (smart note #195) — this redesign styles the states that exist today, it does not invent a reason surface that the contract cannot yet supply.

---

## Key Decisions

- Run-centric unified list over three stacked sections: collapsing Recent Runs + Launch + live Runs into one "run" object is the core fix for the flat-dump feel and the fragmented loop.
- Inline expand-to-stream (list rows expand in place) over a two-pane master/detail: keeps a single-column mobile story and avoids adding routing/selection-state machinery.
- Launch as a persistent affordance, standalone Launch panel removed: launch and observation converge on the same run object instead of living in separate regions.
- The redesign spans two layers, not one: the React shell/CSS *and* the security-constrained vanilla `public/operator-*.js` row/stream/approval renderers. The "modern table" is built with safe-DOM (`textContent`/`setAttribute`) unless a hardened renderer is adopted — never a naive JSX/HTML table over untrusted content.
- Safe-DOM plain text with light structural formatting is the default output renderer; Streamdown is a gated fallback, not a coin-flip. Five reviewers independently flagged that adopting a fast-moving markdown→DOM renderer (links/images/raw-HTML, permissive defaults) over attacker-influenceable output is scope and security risk. Streamdown is adopted only if a concrete formatting need can't be met with safe-DOM AND a locked-down config (no raw HTML, `rehype-sanitize` retained, no external link/image origins, data-images off, no CSP relaxation) passes a security-reviewer/Oracle gate. If that gate isn't cleanly passed, safe-DOM is mandatory.

---

## Dependencies / Assumptions

- The Gateway operator contract (pinned `1.5.0`, vendored in `src/gateway/operator-contract/`) already supplies run summaries, the SSE output channel, and approval frames the redesign consumes; no contract change is required for the redesign itself.
- Real-data browser verification requires the orchestrator-owned dev server recipe (backgrounded, no `--watch`, fresh port, orphan cleanup) and real GitHub App creds in `.env`.
- @designer + the installed Impeccable skill (`.agents/skills/impeccable/`) drive the visual execution; the Fro Bot token system already exists in the web app.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R3][Technical] Expansion model: single-open accordion vs multiple simultaneously-expanded runs. Resolve against the runtime lifecycle (one active stream owner) and mobile ergonomics.
- [Affects R7, R15][Needs research] Does any concrete output-readability need actually require markdown rendering, or is safe-DOM structural formatting enough? Safe-DOM is the default (per Key Decisions); only escalate to the Streamdown gated-fallback path if a real formatting requirement can't be met, and only through the security gate in R15. Do not build the React/Streamdown path speculatively.
- [Affects R6][Technical] Runtime ownership when launch inserts a run into the unified list: how the vanilla run-index and stream runtimes converge on one lifecycle owner without double-mounting streams, given today's separate `operator-run-index.js` / `operator-stream.js` owners.
- [Affects R12][Technical] Migration from per-element inline style objects (current `Operator.tsx`) to a token-driven CSS system without regressing CSP (`script-src 'self'`) or the safe-DOM renderers.
- [Affects R2][User decision] At the run-index cap, is a recent-runs window acceptable for v1, or is a minimal retrieval affordance (e.g. filter by state) wanted? The design phase should confirm the window framing reads honestly rather than implying full history.
- [Affects R3, R7][Design] Interaction-state matrix for list rows, expansion, launch affordance, and approvals (loading/empty/error/hover/focus-visible/active/selected/disabled/resolved), plus the approval microstates (pending/submitting/success/failure-retry/resolved). Owned by @designer during execution; flagged so it is not skipped.
