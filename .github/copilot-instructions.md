# Copilot instructions

Read-only Fro Bot monitoring dashboard: a single Hono + JSX SSR Node 24 process, no
build step, native TypeScript. It is an authenticated single-operator view of Fro Bot's
cross-repo footprint. `AGENTS.md` is the canonical context; this file mirrors the
load-bearing rules for code suggestions.

## Security invariants — never generate code that violates these

1. **Read-only by construction.** Every GitHub App installation token is minted with an
   explicit read-only `permissions` subset at mint time
   (`pull_requests`/`checks`/`issues`/`contents`/`metadata: read`, with
   `security_events`/`vulnerability_alerts: read` optional and graceful). Never suggest a
   write/mutating GitHub code path, a broader token scope, or a `permissions` entry above
   `read`.
2. **Redaction preservation.** `src/github/metadata.ts` reads `metadata/repos.yaml` from
   the `fro-bot/.github` `data` branch and exports `redactedNodeIds` (the node_ids of
   `[REDACTED]`/`private: true` entries). The aggregator must exclude denylisted repos
   from the installation-enumerated set **before** any per-repo GraphQL query (a query is
   itself a leak signal), and must fail closed (serve stale/empty, never an unfiltered
   union) if the data-branch read fails. Never render, cache, or log a private repo's real
   name/owner/full_name/node_id.
3. **Never commit the App private key or cookie key.** `*.pem`/`*.key` are gitignored
   in-repo. Do not inline secrets or write them to logs.

## Conventions

- pnpm; Node 24 native TS (strip-only): no enums, namespaces, parameter properties, or TS
  import aliases (`erasableSyntaxOnly` lint enforces this).
- `as unknown as X` for Octokit boundary casts; never `any`.
- `Result<T, E>` error-return shape for the app client.
- Operator (Gateway) auth and the dashboard session cookie are separate credential
  domains; never reuse one as the other.
- Same-origin `/operator/*` is reverse-proxy-routed to the Gateway; the dashboard does not
  mount those routes and must not act as a credential-forwarding proxy.
- Gates before any change is done: `pnpm check-types`, `pnpm lint`, `pnpm test`.
- `docs/solutions/` holds documented solutions to past problems (YAML frontmatter:
  `module`, `tags`, `problem_type`) — consult it when implementing or debugging in a
  documented area.
