# Copilot instructions

Fro Bot monitoring dashboard with a read-only-by-default GitHub data path and one
isolated wiki-write capability: a single Hono + JSX SSR Node 24 process, no
build step, native TypeScript. It is an authenticated single-operator view of Fro Bot's
cross-repo footprint. `AGENTS.md` is the canonical context; this file mirrors the
load-bearing rules for code suggestions.

## Security invariants — never generate code that violates these

1. **Read-only by default, with one isolated wiki-write capability.**
   `DASHBOARD_GITHUB_APP_*` remains strictly read-only: every GitHub App installation
   token is minted with an explicit read-only `permissions` subset at mint time
   (`pull_requests`/`checks`/`issues`/`contents`/`metadata: read`, with
   `security_events`/`vulnerability_alerts: read` optional and graceful), and those
   credentials may never mint write-scoped tokens. For the dashboard web/runtime
   deployment, the only GitHub write authority available to the application is a
   separately deployed `wiki-writer` service authenticated as the Fro Bot App. It may
   target only the `fro-bot/.github` repository's `data` branch, under an explicit
   wiki/corrections path allowlist, executing gates from the shared
   `@fro-bot/wiki-write-core` package. The dashboard web process must never receive the
   Fro Bot App private key or an installation token derived from it. Any additional
   write target or credential requires explicit owner approval and a new threat model.
   This invariant does not govern separately credentialed repository CI/release automation,
   which is not available to the dashboard web process. Do not generate code that expands
   this boundary. Dashboard authentication compromise
   can now produce valid in-scope wiki edits, dashboard RCE can exercise the private
   writer API within scope, writer compromise exposes Fro Bot write authority, and the
   deployment owns another secret, service, health boundary, and incident surface.
   The separation prevents credential exfiltration and arbitrary GitHub operations, but
   cannot prevent a compromised authenticated dashboard from submitting in-scope edits.
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
