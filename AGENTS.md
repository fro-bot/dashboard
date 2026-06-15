# AGENTS.md

Read-only Fro Bot monitoring dashboard. Single Hono + JSX SSR Node 24 process,
no build step, native TS. Authenticated single-operator view of Fro Bot's
cross-repo footprint.

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

- pnpm, Node 24 native TS (strip-only): no enums, namespaces, parameter
  properties, or TS import aliases (`erasableSyntaxOnly` lint enforces this).
- `as unknown as X` for Octokit boundary casts; never `any`.
- `Result<T,E>` error-return shape for the app client (extraction seam).
- Gates: `pnpm check-types`, `pnpm lint`, `pnpm test`.
- `docs/solutions/` — documented solutions to past problems, organized by category
  with YAML frontmatter (`module`, `tags`, `problem_type`). Relevant when
  implementing or debugging in documented areas.

## Cloned Dependency Source

Read-only dependency source repositories are available under
`.slim/clonedeps/repos/` for inspection. Do not edit these clones.

- `.slim/clonedeps/repos/fro-bot__agent/` — `fro-bot/agent` at `main`; the
  gateway's `packages/gateway/src/github/app-client.ts` (installAuth read-only
  permissions pattern), `packages/gateway/src/config.ts` (`readSecret`/
  `readMultilineSecret` + `O_NOFOLLOW`), the Hono build/serve split, and
  `packages/runtime/src/shared/logger.ts` (`Logger` + `redactSensitiveFields` +
  `Result<T,E>`) that this app's primitives mirror for the future
  `@fro.bot/runtime` extraction.
