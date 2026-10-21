# Copilot instructions

Fro Bot monitoring dashboard with a read-only-by-default GitHub data path and one
scoped wiki-write capability: a single Hono + JSX SSR Node 24 process, no
build step, native TypeScript. It is an authenticated single-operator view of Fro Bot's
cross-repo footprint. `AGENTS.md` is the canonical context; this file mirrors the
load-bearing rules for code suggestions.

## Security invariants — never generate code that violates these

1. **Read-only by default, with one scoped wiki-write capability.**
   `DASHBOARD_GITHUB_APP_*` remains strictly read-only: every GitHub App installation
   token is minted with an explicit read-only `permissions` subset at mint time
   (`pull_requests`/`checks`/`issues`/`contents`/`metadata: read`, with
   `security_events`/`vulnerability_alerts: read` optional and graceful), and those
   credentials may never mint write-scoped tokens. The dashboard holds GitHub write
   authority scoped to the single operator (`DASHBOARD_OPERATOR_ID`): outside the dev fixture
   harness, a write runs only for a gateway session whose `operatorId` equals it. That authority comes through a separate
   Fro Bot App credential (`DASHBOARD_FRO_BOT_APP_ID` / `DASHBOARD_FRO_BOT_APP_KEY(_FILE)`;
   the same App `release.yaml` uses via `APPLICATION_ID`, distinct from the read-only Agent
   App). Its client (`src/github/fro-bot-app-client.ts`) mints installation tokens on demand
   with `contents: write` for `fro-bot/.github` only, and its permission type admits no
   other scope. Commits go to the `data` branch and are limited to wiki pages,
   `knowledge/log.md`, `knowledge/index.md` and `knowledge/corrections.yaml`, after the
   shared `@fro.bot/wiki-write-core` gates pass; the only other write is one `promote-data`
   repository dispatch. Only `src/wiki/wiring.ts` and `src/wiki/write-operation.ts`
   may import the write client, and nothing under `web/src` may
   touch key material, Octokit or the write path. Any additional write target, scope or
   credential requires explicit owner approval and a new threat model. This invariant does
   not govern separately credentialed repository CI/release automation, which is not
   available to the dashboard web process. Do not generate code that expands this boundary.
   The cost it accepts: dashboard authentication compromise yields valid in-scope wiki
   edits, and server compromise exposes the Fro Bot App private key, whose App installation
   is broad, so the mint-time `permissions` subset is the only thing that keeps a minted
   token narrow. The `data` branch and the path allowlist (`src/wiki/paths.ts`) are enforced
   in application code, not by the token. The wiki read routes serve only content that is already public on `fro-bot/.github`, a public repository whose `data` branch anyone can read, so they need a dashboard session but no operator identity match.
2. **Redaction preservation.** `src/github/metadata.ts` reads `metadata/repos.yaml` from
   the `fro-bot/.github` `data` branch and exports `redactedNodeIds` (the node_ids of
   `[REDACTED]`/`private: true` entries). The aggregator must exclude denylisted repos
   from the installation-enumerated set **before** any per-repo GraphQL query (a query is
   itself a leak signal), and must fail closed (serve stale/empty, never an unfiltered
   union) if the data-branch read fails. Never render, cache, or log a private repo's real
   name/owner/full_name/node_id.
3. **Never commit the App private key or cookie key.** `*.pem`/`*.key` are gitignored
   in-repo. Do not inline secrets or write them to logs. Application POST endpoints are
   not GitHub write authority.

## Conventions

- Bun (`bun install`, `bun run <script>`); Node 24 native TS (strip-only): no enums, namespaces, parameter properties, or TS
  import aliases (`erasableSyntaxOnly` lint enforces this).
- `as unknown as X` for Octokit boundary casts; never `any`.
- `Result<T, E>` error-return shape for the app client.
- Operator (Gateway) auth and the dashboard session cookie are separate credential
  domains; never reuse one as the other.
- Same-origin `/operator/*` is reverse-proxy-routed to the Gateway; the dashboard does not
  mount those routes and must not act as a credential-forwarding proxy.
- Gates before any change is done: `bun run check-types`, `bun run lint`, `bun run test` (never a bare `bun test`).
- `docs/solutions/` holds documented solutions to past problems (YAML frontmatter:
  `module`, `tags`, `problem_type`) — consult it when implementing or debugging in a
  documented area.
