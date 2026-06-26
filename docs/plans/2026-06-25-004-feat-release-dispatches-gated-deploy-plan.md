---
title: "feat: release dispatches a gated deploy to infra"
type: feat
status: active
date: 2026-06-25
origin: docs/brainstorms/2026-06-25-002-release-dispatches-gated-deploy-requirements.md
deepened: 2026-06-25
---

# feat: release dispatches a gated deploy to infra

## Overview

After a successful dashboard release publishes the image + CalVer tag to GHCR, automatically dispatch `marcusrbrown/infra`'s `deploy-dashboard.yaml` for that exact version — so a released fix reaches the live host without a remembered manual step, while the operator's approval gate stays the final control. No deploy secret or write-to-prod path enters the read-only dashboard repo; the trigger uses a short-lived, narrowly-scoped GitHub App token.

**Target repos:** this plan spans two. `fro-bot/dashboard` (this repo) gains the post-release dispatch. `marcusrbrown/infra` gains a `version` input on its deploy and consumes it instead of the committed compose pin. Both are stated explicitly per unit.

## Problem Frame

`release.yaml` builds, smoke-tests, and pushes the image/tag to GHCR, then stops. Deploys happen out-of-band from infra (`deploy-dashboard.yaml` → `bun run --cwd apps/dashboard deploy` over SSH) behind a manual approval gate, after the image tag is hand-committed in `apps/dashboard/docker-compose.yaml`. So a released fix sits undeployed until someone bumps the compose pin and triggers infra. The PWA (release `2026.06.47`) is the live example: on GHCR, not deployed (`dashboard.fro.bot/sw.js` → 302). (See origin: `docs/brainstorms/2026-06-25-002-release-dispatches-gated-deploy-requirements.md`.)

## Requirements Trace

- R1. After a successful release, `release.yaml` dispatches infra's `deploy-dashboard.yaml` with the released version. (origin R1)
- R2. Infra deploys the exact dispatched version, digest-pinned; the dispatched value is CalVer-validated. (origin R2)
- R3. The `environment: dashboard` required-reviewer gate remains the sole, unbypassable control, sitting on the deploy job (all prod/secret steps inside it). (origin R3)
- R4. The dashboard repo gains only a dispatch-only, short-lived App-token surface — least-privilege, no deploy secrets. (origin R4)
- R5. The dispatch fires only on a genuine successful release, for a tag actually published in that run. (origin R5)
- R6. Dispatch failure doesn't fail the release; infra rejects stale/duplicate/non-published requests before the gate. (origin R6)

## Scope Boundaries

- Automate up to the gate only — never remove, weaken, or auto-approve it.
- No change to how the image is built or published; only a post-publish dispatch is added.
- No deploy/prod-write secret enters the dashboard repo.

### Deferred to Separate Tasks

- **Infra side (Unit 1 + Unit 1.5)** — tracked as `marcusrbrown/infra#688`, to be done in a dedicated infra session. The dashboard side (Unit 2) depends on it.
- **Dedicated infra-only GitHub App (security hardening)** — the real fix for the App-key blast radius; accepted-tradeoff for now (shared `mrbro-bot` App + dedicated key). Tracked as `fro-bot/dashboard#112`.
- Surfacing the infra deploy-run URL back in the dashboard release — nice-to-have, not in scope.

## Prerequisites (blocking — not deferred)

Unit 2 cannot mint a token or be tested without these; they gate Unit 2:

- **P1. A dedicated private key for the `mrbro-bot` App, used exclusively by `fro-bot/dashboard`** (operator decision — a dedicated infra-only App was declined). Generate a fresh `mrbro-bot` private key for this purpose so it can be rotated/revoked independently of other consumers' keys. (Note the accepted residual risk in KTD: the key authenticates the full `mrbro-bot` App identity; a leak is bounded by the secret-lifecycle controls, not by token scope.)
- **P2. Store the App id + the dedicated private key as dashboard secrets, environment-scoped** to a `release` environment (so only the `environment: release` release job reads them — not arbitrary CI workflows). This is the primary leak mitigation given the shared-App tradeoff.
- These are operator/secret tasks; track and confirm them before Unit 2 lands.

## Context & Research

### Relevant Code and Patterns

- `.github/workflows/release.yaml` — the release job that publishes the image/tag (the dispatch is appended after a successful publish; `release: true` is the existing should-release signal).
- `marcusrbrown/infra` `.github/workflows/deploy-dashboard.yaml` — `on: workflow_dispatch` (no inputs yet) + `workflow_call`; `environment: dashboard`; runs `bun run --cwd apps/dashboard deploy`.
- `marcusrbrown/infra` `.github/workflows/deploy-keeweb.yaml` — the existing `workflow_dispatch.inputs` pattern to mirror for the `version` input.
- `marcusrbrown/infra` `apps/dashboard/src/deploy.ts` — reads the expected digest from `apps/dashboard/docker-compose.yaml` (`readComposeDigest()`), `docker compose pull`s, and hard-verifies the running image's `RepoDigests`. **Digest-pinning is already the model** — the change is making the tag/digest dynamic.
- `marcusrbrown/infra` `apps/dashboard/docker-compose.yaml` — the single place the image ref lives today: `ghcr.io/fro-bot/dashboard:<tag>@sha256:<digest>`.
- `marcusrbrown/systematic` `.github/workflows/docs.yaml` — the `actions/create-github-app-token` mint pattern (`app-id`/`private-key`, `owner`-scoped) this plan follows for the dispatch token.

### External References

- `actions/create-github-app-token@v3` — `owner: marcusrbrown` + `repositories: infra` + `permission-actions: write` mints a ~1h token scoped to dispatch infra's workflow. (github.com/actions/create-github-app-token)
- `workflow_dispatch` with typed `inputs` is the cleaner cross-repo trigger for a known workflow + version (vs `repository_dispatch`, which infra doesn't use). Trigger via the REST `workflow dispatch` endpoint / `gh workflow run`.
- An `environment:` required-reviewer gate fires regardless of trigger source (push / workflow_dispatch / repository_dispatch) — confirmed in GitHub Actions environment docs. The dispatch cannot bypass it.
- Tag→digest: `docker buildx imagetools inspect ghcr.io/...:<tag>` resolves the immutable `@sha256:` digest.

## Key Technical Decisions

- **`workflow_dispatch` + typed `version` input, not `repository_dispatch`.** Typed contract, mirrors infra's `deploy-keeweb.yaml`, and infra has no existing repository_dispatch handling. Dashboard triggers it via the REST workflow-dispatch endpoint using the App token.
- **Digest is passed for cross-check, but infra independently resolves and verifies it — infra never trusts the dispatched digest.** After publishing, `release.yaml` resolves the just-published tag → digest (`imagetools inspect`) and dispatches version + digest. **Infra independently re-resolves `ghcr.io/fro-bot/dashboard:<version>` to a digest and compares it to the dispatched one; on mismatch it fails hard; on match it deploys the *independently-resolved* digest.** This closes BOTH tag-retargeting (digest pins the manifest) AND a compromised-publisher dispatching a valid CalVer + an attacker-controlled digest (infra's own resolution is the trust anchor, not the dispatch). (Deepen finding: passing the digest alone is *not* tighter against a compromised publisher — only independent infra verification is.)
- **CalVer validation at both ends.** `release.yaml` only dispatches a tag it just published (R5); infra validates the `version` input against `^\d{4}\.\d{2}\.\d+$` before any pull/SSH (R2/R6) and rejects anything else.
- **Gate on the deploy job (R3) + make the version visible at the gate.** All prod-touching + secret-consuming steps stay inside the single `environment: dashboard` job; no pre-gate SSH/pull/secret access. **Because GitHub's approval modal does NOT show workflow inputs**, the deploy must surface the version where the operator sees it before approving: set `run-name: Deploy dashboard <version>` and add a pre-gate (no-secret, no-SSH) job that logs version + digest + the originating release run URL. Without this the "operator sees the version" mitigation is theater. (Deepen finding.)
- **App-token auth — shared `mrbro-bot` App + a dedicated per-repo private key (operator decision), with the blast-radius tradeoff recorded honestly.** Mint via `create-github-app-token` against the existing `mrbro-bot` App (installed across `marcusrbrown/*`), using a **private key created exclusively for `fro-bot/dashboard`** (matching the `marcusrbrown/systematic` convention). The mint narrows the *token* to `repositories: infra` + `permission-actions: write`, so the token a normal run produces is minimal. **Accepted residual risk (do not call this "least-privilege"):** the per-repo key authenticates the *same* `mrbro-bot` App identity, so the mint-time narrowing does NOT bound a key-leak blast radius — a leaked dashboard key lets a holder call `POST /app/installations/{id}/access_tokens` directly for the App's full installed scope across `marcusrbrown/*`. This is accepted as the operator's chosen tradeoff (dedicated App declined); it is mitigated by secret-lifecycle controls (below), not by token scope. Token is short-lived (~1h), never echoed.
- **Secret lifecycle for the App key in the read-only dashboard repo (P1 security finding).** The key IS a deploy-trigger credential, so: environment-scope it (store under a `release` environment so only the `environment: release` release job can read it, not arbitrary CI workflows); SHA-pin every action in `release.yaml` (incl. `create-github-app-token`); require CODEOWNERS review on `release.yaml`; document rotation. The dashboard repo holds no SSH/host secret, but it now holds a cross-repo trigger key that needs at-rest protection.
- **Compose remains the audit source of truth — the deploy templates it AND commits the updated pin (architecture finding, resolved not deferred).** infra's `deploy.ts` reads the dispatched version/digest, string-replaces the image line in the compose content, SCPs the modified content, and `assertRunningImageDigest` still verifies. **After a successful deploy, an infra step commits the updated `apps/dashboard/docker-compose.yaml` pin back to `main`** (needs `contents: write` in the deploy job — no new prod surface, the job already holds SSH+secrets), so the committed compose stays the auditable record of what's running. The committed pin is also the fallback default when no `version` is dispatched (manual path).
- **Best-effort dispatch (R6).** The dispatch step runs after the image is published and does not fail the release job on dispatch error — it surfaces a clear annotation for manual retry (`gh workflow run` fallback documented).

## Open Questions

### Resolved During Planning

- Trigger mechanism — `workflow_dispatch` + typed input (research: infra has no repository_dispatch pattern; keeweb shows the input pattern).
- Does the gate still fire on a dispatched run — yes (GitHub env-protection docs).
- How infra picks the version today — committed digest in `apps/dashboard/docker-compose.yaml`, verified by `deploy.ts`; the minimal change is a dynamic override.

### Resolved During Deepening

- The `deploy.ts` / compose change shape — resolved: `deploy.ts` templates the compose image line from version+digest (string-replace + SCP), and the deploy commits the updated pin back to `main` so the committed compose stays the audit record (KTD). The deepen pass found a bare env-var override of `readComposeDigest()` doesn't work — `docker compose pull` reads the SCP'd file, so the file content must be templated either way.
- Fallback semantics — resolved: the committed pin is the source of truth when no `version` is dispatched; a non-empty validated `version` always wins; never both.

### Deferred to Implementation

- The exact string-replace + post-deploy `git commit/push` mechanics in `deploy.ts` (rebase-retry on a racing push), decided against the real `deploy.ts` structure during the infra unit.

## Implementation Units

- [ ] **Unit 1 (infra): accept a `version` input and deploy that exact, digest-pinned image**

**Target repo:** `marcusrbrown/infra`

**Goal:** `deploy-dashboard.yaml` accepts a `version` (and optional `digest`) input, CalVer-validates it, and the deploy uses it instead of the committed compose pin — preserving the existing digest-verify.

**Requirements:** R2, R3, R6

**Dependencies:** None (can land first; dashboard Unit 2 depends on this existing)

**Files:**
- Modify: `.github/workflows/deploy-dashboard.yaml` (add `workflow_dispatch.inputs.version` + optional `digest`; keep `workflow_call`; CalVer-validate before the deploy job; pass into the deploy step's env)
- Modify: `apps/dashboard/src/deploy.ts` (consume the dispatched version/digest; override or template the compose image ref; keep the RepoDigests hard-verify)
- Possibly modify: `apps/dashboard/docker-compose.yaml` (templated image ref, or leave as the committed fallback default)
- Test: infra's deploy-script test suite (mirror its existing `src/deploy.ts` tests if present)

**Approach:**
- Add `inputs.version` + optional `inputs.digest` + `inputs.contract_version` (a fuse: dashboard sends `"1"`; infra fails fast pre-gate on an unrecognized contract_version so a renamed-input contract change can't silently fall back instead of erroring). `version` falls back to the committed compose pin when absent, preserving the manual path. Validate `version` against `^\d{4}\.\d{2}\.\d+$` in a guard step; fail fast on mismatch (R6). Document the input contract in a header comment in `deploy-dashboard.yaml`.
- **Infra independently resolves and verifies the digest (do NOT trust the dispatched digest).** Resolve `ghcr.io/fro-bot/dashboard:<version>` → digest via `imagetools inspect`; compare to the dispatched `digest`; on mismatch fail hard; on match deploy the independently-resolved digest. Keep the existing RepoDigests verification (R2).
- **Compose stays the audit record.** `deploy.ts` templates the image line in the compose content from version+digest (string-replace + SCP the modified content), keeping `assertRunningImageDigest`. After a successful deploy, commit the updated `apps/dashboard/docker-compose.yaml` pin back to `main` (the deploy job gains `contents: write` — no new prod surface). When no `version` is dispatched, the committed pin is the source of truth (manual fallback). Precedence is explicit: a non-empty validated `version` always wins; empty/absent → compose pin; the two never both apply.
- Keep ALL SSH/pull/secret steps in the `environment: dashboard` job (R3) — no pre-gate work except the no-secret contract/CalVer guard + the informational version log.

**Execution note:** Test-first for the CalVer validation, the contract_version fuse, and the independent digest-resolve-and-compare (the security-bearing parts).

**Patterns to follow:** `deploy-keeweb.yaml` (`workflow_dispatch.inputs`); the existing `deploy.ts` digest-verify + `readComposeDigest`.

**Test scenarios:**
- Happy: a valid `version` resolves the right image ref; infra's independent digest matches the dispatched one; deploy proceeds and commits the updated pin.
- Edge: no `version` input → falls back to the committed compose pin (manual path unchanged).
- Error (security): a malformed/injected `version` (`latest`, `2026.06.47; rm -rf`, `../`) is rejected by the CalVer guard before any pull/SSH.
- Error (security): dispatched `digest` ≠ infra's independently-resolved digest → fail hard, before touching the host (catches a compromised-publisher / retargeted tag).
- Error: an unrecognized `contract_version` → fail fast pre-gate (catches contract drift instead of silent fallback).
- Integration: the RepoDigests verify still fails the deploy if the running image doesn't match.

**Verification:** a dispatched valid version deploys the independently-verified digest behind the gate and commits the pin; an invalid version/digest/contract is rejected pre-deploy; the manual no-input path still works.

- [ ] **Unit 1.5 (infra): manual-dispatch dry-run — de-risk the path before wiring auto-dispatch**

**Target repo:** `marcusrbrown/infra` (operational — no new code)

**Goal:** prove Unit 1's full path works via a manual `workflow_dispatch` before any dashboard change or secret provisioning, so failures surface infra-side with nothing else in flight.

**Requirements:** R2, R3 (de-risks the path)

**Dependencies:** Unit 1 merged.

**Approach:**
- In infra's Actions UI, manually run `deploy-dashboard.yaml` with a real current GHCR version → verify: CalVer passes, the version overrides the compose pin, the right image is SCP'd + pulled + running, `assertRunningImageDigest` passes, the gate holds for approval, the pin commit lands.
- Run again with no `version` → verify the compose-pin fallback still works.
- Run with a malformed `version` (`latest`, an injection string) → verify rejection before any pull/SSH.

**Verification:** all three manual dispatches behave correctly; the version-override + fallback + rejection paths are proven with zero dashboard changes and no App secret. Only then proceed to Unit 2.

- [ ] **Unit 2 (dashboard): mint the App token and dispatch infra after a successful release**

**Target repo:** `fro-bot/dashboard` (this repo)

**Goal:** after `release.yaml` publishes the image/tag, resolve its digest, mint a short-lived scoped App token, and dispatch infra's `deploy-dashboard.yaml` with `version` (+ digest + contract_version) — best-effort, not failing the release.

**Requirements:** R1, R4, R5, R6

**Dependencies:** Unit 1 + Unit 1.5 (the path is proven); **the dedicated App + environment-scoped secrets MUST be provisioned first (Prerequisites P1/P2) — Unit 2 cannot mint a token or be tested without them.**

**Files:**
- Modify: `.github/workflows/release.yaml` (append a post-publish dispatch: resolve digest → `create-github-app-token` → dispatch infra)
- Test: `test/should-release.test.ts` is unrelated; CI-config behavior is verified by the workflow itself + `actionlint`.

**Approach:**
- Gate the dispatch on a genuine successful release (the existing `release` output / job success), using the just-published tag — never a skipped/failed release (R5).
- Resolve the published tag → digest with `docker buildx imagetools inspect` (the image was just pushed in this job).
- Mint via `actions/create-github-app-token@v3` using the `mrbro-bot` App with the **dedicated dashboard-only private key** (Prerequisites), `owner: marcusrbrown`, `repositories: infra`, `permission-actions: write` (mint-time token narrowing — R4) → call the REST workflow-dispatch endpoint for `deploy-dashboard.yaml` with `inputs: { version, digest, contract_version: "1" }`.
- The dispatch step runs in a job that declares `environment: release` (so it — and only it — can read the App secret). **SHA-pin every action in `release.yaml`** (incl. `create-github-app-token`). Never echo the key; keep `ACTIONS_STEP_DEBUG` off.
- Wrap the dispatch so a failure annotates + continues (does not fail the release) — the image is already published (R6). A dispatch failure should distinguish a contract mismatch (422 from the API) from a token/network error in its annotation.

**Execution note:** Workflow change — validate with `actionlint`; the security-bearing logic (only-on-real-release, the dedicated-App scope, SHA-pinned actions, environment-scoped secret) is reviewed, not unit-tested.

**Patterns to follow:** `marcusrbrown/systematic` `.github/workflows/docs.yaml` (the `create-github-app-token` mint); the existing `release.yaml` job structure.

**Test scenarios:**
- Test expectation: none (CI-config, no app behavior) — verified by `actionlint` + a manual/real release dry-run. The behavioral guarantees (gate fires, digest deploys) are covered by Unit 1's tests + the live verification below.

**Verification:** a real release dispatches infra for the published version; the run shows the App token scoped to infra only; a forced dispatch failure leaves the release green with an annotation.

- [ ] **Unit 3: live verification + close the loop on the PWA deploy**

**Target repo:** operational (no code) — uses the new path to ship + verify the already-released PWA.

**Goal:** exercise the new release→dispatch→gated-deploy path end to end on a real version and verify the live SW registers.

**Requirements:** R1, R3 (proves the gate + the deploy)

**Dependencies:** Units 1 + 2 merged + released.

**Approach:**
- The first release after Unit 2 dispatches infra → the gate pauses for operator approval → on approval, the host runs the new image.
- Verify per the PWA-SW browser-verification learning: `dashboard.fro.bot/sw.js` → 200 (correct MIME), the SW registers/activates, precache populated, offline serves cached data, OAuth not bypassed.

**Test scenarios:**
- Integration (live): post-approval, `/sw.js` is 200 and the SW reaches `activated` on `dashboard.fro.bot`.
- Integration (gate): a dispatched deploy does NOT reach the host until the operator approves.

**Verification:** the live dashboard serves the PWA build and the SW registers; the gate demonstrably held before approval.

## System-Wide Impact

- **Interaction graph:** `release.yaml` (publish → resolve digest → mint token → dispatch) → infra `deploy-dashboard.yaml` (validate → gate → deploy.ts → host). New cross-repo edge; the App token is the only new credential, in dashboard.
- **Error propagation:** dispatch failure is contained to a release annotation (image already published); infra validation failure aborts before the host; the gate stops everything pending approval.
- **Unchanged invariants:** image build/publish path; the dashboard read-only posture (no deploy secret; the token is dispatch-only); infra's digest-verify deploy model; the operator approval gate (preserved, on the deploy job).
- **API surface parity:** infra's `deploy-dashboard.yaml` gains a `version` input but keeps `workflow_dispatch` (manual) + `workflow_call` working (input optional, falls back to the compose pin).

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Tag retargeting (tag→different manifest between dispatch and deploy) | CalVer-validate; infra independently resolves the tag→digest and deploys *that* (R2) |
| **Compromised publisher** dispatches a valid CalVer + an attacker-controlled digest | Infra does NOT trust the dispatched digest — it independently resolves the digest and compares; mismatch fails hard (KTD; distinct from tag-retarget) |
| **App key leak = the `mrbro-bot` App's FULL installation scope across `marcusrbrown/*`** (a dedicated per-repo key does NOT reduce this — mint-time narrowing doesn't bound a key holder calling the API directly; dedicated App declined) | **Accepted tradeoff**, mitigated by secret-lifecycle controls: environment-scope the secret to the `release` env (primary control); SHA-pin all `release.yaml` actions; CODEOWNERS on `release.yaml`; dedicated rotatable key; `ACTIONS_STEP_DEBUG` off |
| Operator approves a malicious version without noticing (gate-as-check is theater) | `run-name: Deploy dashboard <version>` + a pre-gate informational job logging version/digest/source so the version is visible before approval (KTD); CalVer + digest verify are the real controls, the gate is the backstop |
| Dispatch bypasses the approval gate | Gate is on the deploy job; fires regardless of trigger (confirmed in GitHub docs) — the dispatch reaches it and stops (R3) |
| Contract drift (infra renames an input) → dispatch silently falls back to the old pin | `contract_version` fuse: infra fails fast pre-gate on an unrecognized value; a mismatched input contract also returns a 422 the dispatch annotates (R6) |
| Dispatch fails / replayed | Best-effort (doesn't fail the release); a re-dispatch of the same version is **idempotent** (`docker compose pull` + `up -d` of the same digest is a harmless re-create, brief restart gated by the health check) — true stale/duplicate *rejection* would need persistent state and is out of scope; R6 is satisfied by idempotency, not dedup |
| Cross-repo coupling (dashboard depends on infra's input contract) | Unit 1 + 1.5 land + are proven first; the `version` input is optional (back-compatible); the `contract_version` fuse turns a silent drift into a loud failure |

## Documentation / Operational Notes

- After shipping, add a brief note to `AGENTS.md` / a runbook: releasing now auto-dispatches the gated infra deploy; the operator approves in the `dashboard` environment.
- The dedicated App + environment-scoped private key/id must be provisioned (Prerequisites P1/P2) **before Unit 2** — a blocking operator task, and the App's installation scope (infra-only, actions:write-only) is what bounds the key-leak blast radius, so it must be verified, not assumed.
- Consider a `docs/solutions/` learning capturing the publish→gated-deploy dispatch pattern (cross-repo, App-token, gate-preserving) — it pairs with the release-path and the publish-vs-deploy-gap learnings.

## Sources & References

- **Origin document:** `docs/brainstorms/2026-06-25-002-release-dispatches-gated-deploy-requirements.md`
- Related code: `.github/workflows/release.yaml`; `marcusrbrown/infra` `.github/workflows/deploy-dashboard.yaml`, `apps/dashboard/src/deploy.ts`, `apps/dashboard/docker-compose.yaml`, `.github/workflows/deploy-keeweb.yaml`; `marcusrbrown/systematic` `.github/workflows/docs.yaml`
- External: `actions/create-github-app-token@v3`; GitHub Actions docs (workflow_dispatch event + REST dispatch, environments/required reviewers); GHCR/OCI digest (`imagetools inspect`)
