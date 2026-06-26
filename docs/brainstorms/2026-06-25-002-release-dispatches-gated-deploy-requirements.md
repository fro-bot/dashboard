---
date: 2026-06-25
topic: release-dispatches-gated-deploy
status: requirements
mode: repo-grounded
---

# Requirements: Release dispatches a gated deploy to infra

## Problem & Goal

A merged + green + released dashboard change is invisible to users until the live host pulls the new image. Today `release.yaml` builds, smoke-tests, and pushes the image + CalVer tag to GHCR — and stops. Deploys happen out-of-band from `marcusrbrown/infra` (`deploy-dashboard.yaml`, which SSHes to the host) after a version bump, behind a manual approval gate. So a released fix sits undeployed until someone remembers to trigger infra. The PWA (release `2026.06.47`) is the live example: published to GHCR, not yet deployed (`dashboard.fro.bot/sw.js` → 302, the old image).

**Goal:** after a successful dashboard release, automatically dispatch infra's deploy for the exact released version — while preserving the operator's approval gate as the final control, and adding no deploy secret or write-to-prod path to the read-only dashboard repo.

## Confirmed Decisions

- **Trigger:** after `release.yaml` publishes the image + tag, it dispatches infra's `deploy-dashboard.yaml`.
- **Version handoff:** the dispatch passes the **released version tag** (e.g. `2026.06.47`); infra deploys **that exact tag** — no `:latest` drift; the deployed version is explicit in the dispatch and the deploy run.
- **Approval gate preserved:** infra's `environment: dashboard` has `required_reviewers: [marcusrbrown]`. That gate fires on every run of `deploy-dashboard.yaml` regardless of trigger source, so the automation reaches the gate and **stops there** — nothing auto-deploys to prod.
- **Auth = short-lived mrbro-bot App token** (the established `marcusrbrown/systematic` convention): mint via `actions/create-github-app-token` with `app-id` + a **private key created exclusively for this dashboard→infra dispatch**, `owner: marcusrbrown`, scoped to dispatch `deploy-dashboard.yaml`. No long-lived PAT.

## Requirements

- **R1.** After a successful release in `release.yaml` (image + tag published to GHCR), the workflow dispatches `marcusrbrown/infra`'s `deploy-dashboard.yaml`, passing the released CalVer tag.
- **R2.** Infra deploys the **exact** dispatched version (not `:latest`, not a re-resolved version). `deploy-dashboard.yaml` accepts a version input — a small, in-scope infra change. To defeat tag confusion / mutable-tag retargeting, the dispatched value MUST be validated against an exact CalVer allowlist (`YYYY.MM.N`), and infra SHOULD resolve and pull by **immutable digest** for that tag (or a release-published immutable manifest), not trust the mutable tag alone.
- **R3.** The operator approval gate (`environment: dashboard` required reviewer) remains the sole, unbypassable final control on every deploy. The automation must not remove, weaken, or auto-satisfy it. **The gate must sit on the deploy JOB:** every prod-touching step (SSH, host image-pull, restart) and every deploy-secret-consuming step lives inside the single job protected by `environment: dashboard`. No pre-gate job may SSH the host, pull the image to prod, or read a deploy secret. (A `workflow_dispatch`/`repository_dispatch`/`workflow_call` trigger still hits the environment protection only because the prod work is in that gated job — so this placement is a requirement, not an assumption.)
- **R4.** The dashboard repo gains **only** a dispatch-only credential surface: a short-lived mrbro-bot App token minted at release time. No SSH key, App key, OAuth, or cookie-key deploy secret enters the dashboard repo — those stay in infra. Secret-lifecycle requirements: the App installation is least-privilege (`actions: write` on `marcusrbrown/infra` only, nothing org-wide or broader); the dedicated private key is a protected dashboard secret, rotatable, and never echoed to logs; the doc acknowledges the dashboard repo now stores a cross-repo *trigger* credential (it cannot SSH prod, but it can request infra deploys — see R6/threat model).
- **R5.** The dispatch fires only on a genuine successful release (not on a skipped/failed release, not on `workflow_dispatch` dry runs that don't release). It must not deploy a version that wasn't actually published. The dispatched tag must correspond to an artifact this repo actually published in the same run.
- **R6.** Failure isolation + provenance: a dispatch failure (token, network, infra unavailable) must not fail or roll back the release itself — the image is already published; the dispatch is a best-effort handoff that surfaces a clear error for a manual retry. **Replay/forgery resistance:** the dispatch carries the release identity (release SHA + tag) and infra rejects stale or duplicate deploy requests and logs the release-to-deploy correlation, so a replayed/old dispatch cannot silently redeploy a wrong version. Infra re-checks that the requested tag is a real published dashboard release **before** the gate.

## Constraints (preserved invariants)

- **Read-only by construction** (AGENTS.md): the dashboard repo holds no deploy/prod-write secret. The App token is dispatch-only (trigger a workflow in one repo), short-lived, and mints nothing that can write to the host.
- **The approval gate is intentional and stays.** This work automates *up to* the gate, never through it.
- **Secret separation:** deploy secrets (SSH, App key, OAuth, cookie key) live in infra's `dashboard` environment, not in dashboard.
- **No change to how the image is built/published** — only a post-publish dispatch is added.
- **Bounded blast radius:** if `release.yaml` or the App key is compromised, the attacker still cannot SSH prod from dashboard — but they *can* request infra deploys. That blast radius is bounded by R2 (CalVer allowlist + digest pin), R6 (infra re-checks the tag is a genuine published release before the gate), and R3 (the human approval gate sees the version). Dashboard can only ever *request* a deploy of a tag it actually published; infra is the enforcement point.

## Success Criteria

- Merging a dashboard change that releases → `release.yaml` publishes the image + tag → infra's deploy is dispatched for that exact tag → it waits on the operator's approval → on approval, the live host runs the new image.
- The deployed version visibly matches the released tag (in the dispatch payload + infra deploy run log).
- A released-but-unapproved change does **not** reach prod (gate holds).
- A dispatch failure leaves the release intact and surfaces an actionable error.
- The dashboard repo's secret set gains only the mrbro-bot App id + the dedicated private key; no deploy credentials.

## Open Questions (for planning)

- The exact dispatch mechanism: `repository_dispatch` (event payload) vs `gh workflow run` / `workflow_dispatch` with inputs — and how infra's `deploy-dashboard.yaml` consumes the tag (a `workflow_dispatch` input vs a `repository_dispatch` client-payload field).
- How infra's `bun run --cwd apps/dashboard deploy` currently resolves the image version (a bump file vs `:latest`), and the minimal change to make it honor the dispatched tag.
- Provisioning: registering the dedicated mrbro-bot private key + app-id as dashboard secrets (`FRO_BOT_APPLICATION_ID` analog), and confirming the App installation on `marcusrbrown/infra` grants `actions: write` (dispatch) and nothing broader.
- Whether to also surface the deploy run URL back in the dashboard release (nice-to-have, not required).

## Grounding (verified this session)

- `.github/workflows/release.yaml` — builds + smoke-tests + pushes the image/tag to GHCR, then stops (no deploy/dispatch step).
- `marcusrbrown/infra` `.github/workflows/deploy-dashboard.yaml` — already has `workflow_dispatch` + `workflow_call`; runs `bun run --cwd apps/dashboard deploy` over SSH; uses `environment: dashboard`.
- `marcusrbrown/infra` `dashboard` environment — `protection_rules: [required_reviewers, branch_policy]`, `reviewers: [marcusrbrown]` (the gate).
- Auth pattern: `marcusrbrown/systematic` `.github/workflows/docs.yaml` mints a short-lived token via `actions/create-github-app-token` (`app-id` + `private-key`, `owner`-scoped) for cross-repo work — the convention R4 follows.
- Live deploy gap evidence: `dashboard.fro.bot/api/healthz` → 200 (server up) but `/sw.js` → 302 (old image; PWA not yet deployed) while release `2026.06.47` + `:latest` are 200 on GHCR.
