# AGENTS.md

Fro Bot monitoring dashboard with a read-only-by-default GitHub data path and one
scoped wiki-write capability. Two parts in one repo: a Node 24
native-TS Hono server (`src/`, strip-only, no backend build step) that serves the
API + GitHub OAuth, and a Vite + React 19 + Tailwind v4 PWA client (`web/`, built
via `bun run build:web` → `web/dist`, served at `/`). Authenticated single-operator
view of Fro Bot's cross-repo footprint.

## Critical security invariants

1. **Read-only by default, with one scoped wiki-write capability.**
   `DASHBOARD_GITHUB_APP_*` remains strictly read-only: every installation token
   is minted with an explicit read-only `permissions` subset at mint time
   (`pull_requests/checks/issues/contents/metadata:read`, with
   `security_events`/`vulnerability_alerts:read` optional + graceful), and those
   credentials may never mint write-scoped tokens.

   The dashboard holds GitHub write authority scoped to the single operator
   (`DASHBOARD_OPERATOR_ID`): outside the dev fixture harness, a write runs only for a
   gateway session whose `operatorId` equals it. That authority comes through a separate Fro Bot App
   credential (`DASHBOARD_FRO_BOT_APP_ID` / `DASHBOARD_FRO_BOT_APP_KEY(_FILE)`) — the
   same App `release.yaml` authenticates as via `APPLICATION_ID`, distinct from the
   read-only Agent App behind `DASHBOARD_GITHUB_APP_*`. Its client
   (`src/github/fro-bot-app-client.ts`) mints installation tokens on demand with
   `permissions: {contents: 'write'}` for `fro-bot/.github` only, and its permission
   type admits no other scope. Commits go to the `data` branch and are limited to wiki
   pages, `knowledge/log.md`, `knowledge/index.md` and `knowledge/corrections.yaml`,
   after the shared `@fro.bot/wiki-write-core` gates pass; the only other write is one
   `promote-data` repository dispatch. Only `src/wiki/wiring.ts` and `src/wiki/write-operation.ts`
   may import the write client
   (`test/wiki-credential-boundary.test.ts`), and `web/src/wiki/no-key-material.test.ts`
   keeps key material, Octokit and the write path out of the client bundle. Any
   additional write target, scope or credential requires explicit owner approval and a
   new threat model.

   This invariant does not govern separately credentialed repository CI/release
   automation, which is not available to the dashboard web process. HTTP POST endpoints
   for listener ingest/acknowledgement, logout, and
   push-subscription lifecycle are application writes, not GitHub write authority.
   The security cost this accepts: dashboard authentication compromise yields valid
   in-scope wiki edits; server compromise exposes the Fro Bot App private key, and that
   App's installation is broad, so the mint-time `permissions` subset is the only thing
   that keeps a minted token narrow. A `contents: write` token covers the whole
   `fro-bot/.github` repository; the `data` branch and the path allowlist
   (`src/wiki/paths.ts`) are enforced in application code, not by the token. The wiki read routes serve only content that is already public on `fro-bot/.github`, a public repository whose `data` branch anyone can read, so they need a dashboard session but no operator identity match.
2. **Redaction preservation.** `src/github/metadata.ts` reads
   `metadata/repos.yaml` from the `fro-bot/.github` `data` branch and exports
   `redactedNodeIds` (node_ids of `[REDACTED]`/`private:true` entries). The
   aggregator MUST exclude denylisted repos from the installation-enumerated set
   BEFORE any per-repo GraphQL query (a query is itself a leak signal), and MUST
   fail closed (serve stale/empty, never an unfiltered union) if the data-branch
   read fails. Never render/cache/log a private repo's real name.
3. **Never commit the App private key or cookie key.** `*.pem`/`*.key` are
   gitignored in-repo (not just machine-global).

## Conventions

- Bun (`bun install`, `bun run <script>`). Server (`src/`, `test/`, `scripts/`) is Node 24 native TS (strip-only): no
  enums, namespaces, parameter properties, or TS import aliases (`erasableSyntaxOnly`
  lint enforces this). The client (`web/`) is a full-TS Vite + React 19 workspace with
  its own `web/tsconfig.json` — excluded from the strip-only lint.
- `as unknown as X` for Octokit boundary casts; never `any`.
- `Result<T,E>` error-return shape for the app client (extraction seam).
- Gates: `bun run check-types` (server + `web/`), `bun run lint`, `bun run test` (rebuilds the
  client via `pretest`, then runs Vitest). Always `bun run test`, never a bare `bun test`,
  which starts Bun's own runner. Build the client with `bun run build:web` →
  `web/dist`; `bun run dev` serves that prebuilt bundle.
- `docs/runbooks/gateway-access.md` — how to reach the gateway behind `/operator/*` and read its
  logs. The operator surface is proxied to `fro-bot/agent`, so operator auth, session, and push
  evidence lives there and no test in this repo can reach it. Requires a local `marcusrbrown/infra`
  checkout.
- `docs/solutions/` — documented solutions to past problems, organized by category
  with YAML frontmatter (`module`, `tags`, `problem_type`). Relevant when
  implementing or debugging in documented areas.
- `.agents/skills/` is the canonical home for cross-harness agent skills (read by
  both OpenCode and GitHub Copilot). Install shared skills there, not per-harness:
  e.g. `npx impeccable install -y --providers=agents --scope=project --no-hooks`. The
  CI Design Check pins Impeccable in `.github/workflows/main.yaml`, and Renovate tracks
  that pin. An older major ignores `.impeccable/config.json` `ignoreValues` and fails
  the gate on intentional brand tokens.
- The design hook runs only through the OpenCode bridge in `.opencode/impeccable/`.
  The repo has no Copilot or Codex hook manifest, so always install with `--no-hooks`.
  The bridge runs the skill's `scripts/impeccable hook` launcher, which execs a native
  engine binary. That binary is gitignored (`.agents/skills/impeccable/scripts/bin/`)
  and fetched per machine into `~/.impeccable/bin/<version>/`, sha256-verified, the
  first time the launcher runs. The bridge warms the engine once per session, and a
  cold machine skips scans with an `engine-pending` warning until the download
  finishes. The integration tests in
  `.opencode/impeccable/hook-bridge.integration.test.ts` warm that cache first, so a
  cold machine needs network access for `bun run test`.
- Live/browser verification needs the dev server backgrounded and run without
  `--watch` (which masks crashes by parking). The recipe — and the orchestrator-owns-
  the-server pattern for subagent verification — is in
  `docs/solutions/workflow-issues/dev-server-hang-background-no-watch-kill-orphans-2026-06-25.md`.
- A `Fro Bot` check that dies in ~34s on `Timeout waiting for server to start after
  5000ms` used to mean a poisoned session cache, recoverable only by deleting every
  `opencode-*` Actions cache. That is fixed upstream as of `fro-bot/agent` v0.107.1,
  which repairs the restored database before bootstrap, so a poisoned cache now heals
  on the next run. The pin is well past that, so **do not purge caches** — on a current
  pin this signature is a new problem, not the old one. Background in
  `docs/solutions/workflow-issues/opencode-bootstrap-timeout-cache-purge-2026-08-31.md`.
- Fro Bot's `output-mode` defaults to `auto`, which resolves to `working-dir` for
  schedule/dispatch runs — the agent edits the tree and expects a caller-side commit/PR
  step. Without one, fixes vanish at runner teardown while reports claim success. The
  workflow now sets `branch-pr` for those triggers; verify delivery by confirming a
  fro-bot-authored PR exists, not by reading run status. See
  `docs/solutions/workflow-issues/workflow-output-mode-auto-discarded-agent-fixes-2026-08-31.md`.
