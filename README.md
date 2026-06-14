# @fro-bot/dashboard

Read-only Fro Bot monitoring dashboard. Surfaces live cross-repo status (open PRs + CI state,
failing checks, open issues, security alerts) for Fro Bot's collaborator repos and Agent App
installations in a single glanceable view.

Built against the Phase 1 plan at
[`fro-bot/.github` docs/plans/2026-06-15-001-feat-monitoring-dashboard-phase-1-plan.md](https://github.com/fro-bot/.github/blob/main/docs/plans/2026-06-15-001-feat-monitoring-dashboard-phase-1-plan.md).

## Stack

- [Hono](https://hono.dev) + `@hono/node-server` — no build step
- Node 24 native TypeScript
- pnpm

## Dev

```sh
pnpm bootstrap   # install deps
pnpm dev         # start with --watch
pnpm check-types # type check
pnpm lint        # lint
pnpm test        # run tests
```

## Endpoints

- `GET /api/healthz` — health check; returns `{ ok, lastFetch, rateLimit }`
