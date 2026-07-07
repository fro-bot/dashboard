# AGENTS.md

Read-only Fro Bot monitoring dashboard. Two parts in one repo: a Node 24
native-TS Hono server (`src/`, strip-only, no backend build step) that serves the
API + GitHub OAuth, and a Vite + React 19 + Tailwind v4 PWA client (`web/`, built
via `pnpm build:web` → `web/dist`, served at `/`). Authenticated single-operator
view of Fro Bot's cross-repo footprint.

## Critical security invariants

1. **Read-only by construction.** Every GitHub App installation token is minted
   with an explicit read-only `permissions` subset at mint time
   (`pull_requests/checks/issues/contents/metadata:read`, with
   `security_events`/`vulnerability_alerts:read` optional + graceful). The Agent
   App's registered permissions are therefore irrelevant to effective access.
   Never add a write code path.
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

- pnpm. Server (`src/`, `test/`, `scripts/`) is Node 24 native TS (strip-only): no
  enums, namespaces, parameter properties, or TS import aliases (`erasableSyntaxOnly`
  lint enforces this). The client (`web/`) is a full-TS Vite + React 19 workspace with
  its own `web/tsconfig.json` — excluded from the strip-only lint.
- `as unknown as X` for Octokit boundary casts; never `any`.
- `Result<T,E>` error-return shape for the app client (extraction seam).
- Gates: `pnpm check-types` (server + `web/`), `pnpm lint`, `pnpm test` (rebuilds the
  client via `pretest`, then runs Vitest). Build the client with `pnpm build:web` →
  `web/dist`; `pnpm dev` serves that prebuilt bundle.
- `docs/solutions/` — documented solutions to past problems, organized by category
  with YAML frontmatter (`module`, `tags`, `problem_type`). Relevant when
  implementing or debugging in documented areas.
- `.agents/skills/` is the canonical home for cross-harness agent skills (read by
  both OpenCode and GitHub Copilot). Install shared skills there, not per-harness:
  e.g. `npx impeccable skills install --providers=agents --scope=project`.
- Live/browser verification needs the dev server backgrounded and run without
  `--watch` (which masks crashes by parking). The recipe — and the orchestrator-owns-
  the-server pattern for subagent verification — is in
  `docs/solutions/workflow-issues/dev-server-hang-background-no-watch-kill-orphans-2026-06-25.md`.

## Cloned Dependency Source

Read-only dependency source repositories are available under
`.slim/clonedeps/repos/` for inspection. Do not edit these clones.

- `.slim/clonedeps/repos/fro-bot__agent/` — `fro-bot/agent` at `v0.78.0`; the
  gateway's operator OAuth return path contract, GitHub App client, secret
  readers, Hono build/serve split, and runtime logger/Result primitives that
  this app mirrors.
