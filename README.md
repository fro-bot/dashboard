<div align="center">

<img src="./assets/banner.svg" alt="dashboard Banner" width="100%" />

# @fro-bot/dashboard

> Command center for Fro Bot operations.

[![Build Status](https://img.shields.io/github/actions/workflow/status/fro-bot/dashboard/main.yaml?style=for-the-badge&label=Build&labelColor=0D0216&color=00BCD4)](https://github.com/fro-bot/dashboard/actions) [![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/fro-bot/dashboard/badge?style=for-the-badge&labelColor=0D0216&color=E91E63)](https://securityscorecards.dev/viewer/?uri=github.com/fro-bot/dashboard) [![Node](https://img.shields.io/badge/Node-%3E%3D24-FFC107?style=for-the-badge&labelColor=0D0216&color=FFC107)](https://nodejs.org)

[Overview](#overview) · [Quick Start](#quick-start) · [Usage](#usage) · [Configuration](#configuration) · [Development](#development)

</div>

---

## Overview

Read-only by default, with one scoped wiki-write capability. The Fro Bot monitoring dashboard
surfaces live cross-repo status (open PRs + CI state,
failing checks, open issues, security alerts) for Fro Bot's collaborator repos and Agent App
installations, plus an authenticated single-operator control surface. Installs as a PWA.

### Stack

- **Server** — [Hono](https://hono.dev) + `@hono/node-server` on Node 24 native TypeScript
  (strip-only, no backend build step). Serves the API, GitHub OAuth, and the built client.
- **Client** — [Vite](https://vite.dev) + [React 19](https://react.dev) +
  [Tailwind CSS v4](https://tailwindcss.com), shipped as an installable PWA
  ([vite-plugin-pwa](https://vite-pwa-org.netlify.app) + [Workbox](https://developer.chrome.com/docs/workbox)).
- [Bun](https://bun.sh) for package management and scripts, [Vitest](https://vitest.dev).

## Quick Start

```sh
bun install            # install deps
bun run build:web      # build the client bundle into web/dist
bun run dev            # start the server with --watch
```

Remove any existing `node_modules` before the first `bun install`.

`bun run dev` serves the prebuilt client from `web/dist`, so run `bun run build:web` first (or after
client changes). The test suite rebuilds the client automatically via `pretest`.

## Usage

### Endpoints

- `GET /` — operator PWA shell (requires a valid operator session).
- `GET /api/healthz` — public health check; returns `{ ok, lastFetch, rateLimit }`.
- `GET /api/monitoring` — minimized monitoring snapshot for the client (authenticated).
- `GET /api/status` — full internal snapshot (authenticated).
- `GET /auth/login` · `GET /auth/callback` · `POST /auth/logout` — GitHub OAuth session flow.
- `/manifest.webmanifest`, `/sw.js` — PWA manifest and service worker.

## Configuration

Access is single-operator: GitHub OAuth authenticates the request and an exact, case-sensitive
login allowlist gates every non-public route. Sessions are HttpOnly, Secure, SameSite=Lax signed
cookies; logout is CSRF-protected.

The dashboard mints each GitHub App installation token with an explicit read-only permissions
subset (`pull_requests`/`checks`/`issues`/`contents`/`metadata:read`, with
`security_events`/`vulnerability_alerts:read` optional). `DASHBOARD_GITHUB_APP_*` may never
mint write-scoped tokens.

The dashboard holds GitHub write authority scoped to the single operator
(`DASHBOARD_OPERATOR_ID`): outside the dev fixture harness, a write runs only for a gateway
session whose `operatorId` equals it.
That authority comes through a separate Fro Bot App credential (`DASHBOARD_FRO_BOT_APP_ID` /
`DASHBOARD_FRO_BOT_APP_KEY(_FILE)`) — the same App `release.yaml` uses via `APPLICATION_ID`,
distinct from the read-only Agent App behind `DASHBOARD_GITHUB_APP_*`. It mints installation
tokens on demand with `contents: write` for `fro-bot/.github` only. Commits go to the `data`
branch and are limited to wiki pages, `knowledge/log.md`, `knowledge/index.md` and
`knowledge/corrections.yaml`, after the shared `@fro.bot/wiki-write-core` gates pass; the only
other write is one `promote-data` repository dispatch. Any additional write target, scope or
credential requires explicit owner approval and a new threat model. Repository CI/release
automation is separately credentialed and outside this web/runtime boundary.

The cost this accepts: a compromised dashboard login yields valid in-scope wiki edits, and a
compromised server exposes the Fro Bot App private key. That App's installation is broad, so the
mint-time `permissions` subset is what keeps a minted token narrow, and the `data` branch and path
allowlist are enforced in application code, not by the token. The wiki read routes serve only content that is already public on `fro-bot/.github`, a public repository whose `data` branch anyone can read, so they need a dashboard session but no operator identity match.
Existing application POST endpoints are not GitHub write authority. See [docs/runbooks/wiki-editor.md](docs/runbooks/wiki-editor.md).

Redaction is enforced from `metadata/repos.yaml` on the `fro-bot/.github` `data` branch:
denylisted repos are excluded before any per-repo query, and the app fails closed if that read
fails. The App private key and cookie key are never committed (`*.pem`/`*.key` are gitignored
in-repo).

## Development

```sh
bun run check-types # type check server + client
bun run lint        # lint
bun run test        # build client, then run tests (not a bare `bun test`)
```

`Dockerfile` builds the client in a builder stage and runs `node src/server.ts` against a
production-only dependency install.

---

<div align="center">

<sub>Part of the <a href="https://github.com/fro-bot">Fro Bot</a> ecosystem</sub>

</div>
