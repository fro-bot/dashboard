---
title: Base-image Trivy alerts are unfixable by design
date: 2026-08-30
category: best-practices
module: dashboard
component: tooling
problem_type: tooling_decision
severity: high
applies_when:
  - Auditing GitHub code-scanning alerts from the release container
  - Trivy reports Debian package CVEs with no upstream fixed version
  - An automated report frames inherited OS CVEs as an outstanding gap
  - Considering a base-image swap to clear inherited operating-system findings
  - The release Trivy enforcement pass fails on fixable HIGH/CRITICAL base-image CVEs
tags:
  - trivy
  - docker
  - debian
  - trixie
  - base-image
  - unfixed-cves
  - release-gate
  - distroless
---

# Base-image Trivy alerts are unfixable by design

## Context

The release image is built `FROM node:24-trixie-slim` (Debian 13), digest-pinned,
in all three Dockerfile stages (`builder`, `prod-deps`, runtime). An automated
daily report can flag the open `trivy/release-image` code-scanning alerts as an
outstanding security gap. The framing is wrong, and re-deriving that each time
the report runs is pure cost.

As of PR #576 the reporting pass lists 43 HIGH and 0 CRITICAL findings. They are
inherited Debian OS packages in the base image. Each is either unfixed or marked
`fix_deferred` by Debian. Both leave `Fixed Version:` empty, so there is no
upstream package version to move to.

## Guidance

Triage inherited base-image OS findings in this order. Stop as soon as a step
settles the question.

**1. Check `Fixed Version` before anything else.** An empty value means no
upstream patch exists and nothing at the application or Dockerfile layer can
clear it. Parse it correctly — see the trap in Examples.

**2. Confirm the digest is already current.** These findings are only
actionable if a newer base image exists. Compare the pinned digest against what
the registry currently serves:

```sh
token=$(curl -s "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).token')
curl -s -H "Authorization: Bearer $token" \
  -H "Accept: application/vnd.oci.image.index.v1+json" \
  -D- -o /dev/null "https://registry-1.docker.io/v2/library/node/manifests/24-trixie-slim" \
  | grep -i docker-content-digest
```

Renovate already keeps this pin current, so a match is the expected result.

**3. Understand that reporting and enforcement are separate steps.**
`.github/workflows/release.yaml` runs Trivy twice, deliberately:

| Step | Configuration | Effect |
| --- | --- | --- |
| Reporting (~lines 297-308) | `exit-code: '0'`, no `ignore-unfixed` | Uploads every HIGH/CRITICAL to code scanning. This is what produces the alerts, and it is a visibility channel by design. |
| Enforcement (~lines 338-347) | `ignore-unfixed: true`, `exit-code: '1'` | Fails the release only on *fixable* HIGH/CRITICAL. |

An open alert is therefore not a blocked release. Confirm this rather than
assume it: releases `2026.08.31` through `2026.08.34` all built and shipped with
alerts open.

The gate passes today only because no remaining finding has a fix. It fails
again, by design, when Debian ships one. That is the control working, not a
reason to weaken it.

A green Release run is not evidence the image is clean. When the release guard
skips a run (for example a devDependency-only change), no image is built or
scanned. Read the enforcement step's result, or confirm an image was built,
before drawing a conclusion.

**4. Assess reachability before considering a swap.** The deployed container
runs `read_only: true`, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`,
`user: node`, and `/tmp` on tmpfs, with the `/data` bind mount as the only
writable surface. The server is a Node HTTP process that never shells out, so
`perl`, `util-linux`, `ncurses`, and `gzip` are never invoked.

**5. Only then evaluate a base change,** and measure the built image rather than
the bare base — the runtime stage deletes package managers and adds application
code, so a bare-base scan overstates what actually ships. Note also that only the
final stage ships; `builder` and `prod-deps` are discarded.

## Why This Matters

Unfixable findings are not gaps. Treating them as a backlog produces
deploy risk with no security gain, and the enforcement scan already draws the
distinction correctly — so the work is not just low-value, it is redundant with
a control that already exists.

The reachability argument compounds it. These packages sit in a read-only,
capability-stripped, non-root container that never spawns a process. Removing
them changes the theoretical surface, not the practical one.

The parsing trap matters more than it looks: getting it wrong inverts the entire
conclusion, turning "nothing is actionable" into "everything is fixable" and
justifying work that cannot succeed.

This is an accepted, bounded posture — not a suppressed vulnerability. Keep the
findings visible. Do not change application code, the release gate, or the
Dockerfile solely to reduce the alert count, and do not add ignores or loosen
the enforcement pass to make a failing release go green.

The `node:24-trixie-slim` base is not a policy artifact to preserve or revert
for alert-count reasons. It is the current base because it carries fixes the
previous Debian release's tag did not (next section). Move it only for a
concrete reason, and move all three stages together.

## Why the base is trixie: fixable CVEs blocked the gate

The enforcement pass began failing every image release once Debian fixed
`perl-base` CVE-2026-13221, CVE-2026-42496, CVE-2026-8376 (critical) and
CVE-2026-42497, CVE-2026-48962, CVE-2026-57432, CVE-2026-57433 (high) in
`5.36.0-7+deb12u4`, while the `node:24-slim` tag head still shipped
`5.36.0-7+deb12u3`. These findings were fixable, so the gate was right to fail,
but a digest bump could not help until upstream rebuilt the tag.

PR #576 moved all three Dockerfile stages to `node:24-trixie-slim`. They move
together because `prod-deps` compiles native modules that are copied into the
runtime stage, so the glibc must match. After the move, the Release run for #576
(Actions run 37574091492) passed the enforcement pass on Debian 13.7, where
`perl-base` is `5.40.1-6+deb13u1`. The remaining reporting-pass findings stay
visible in code scanning.

A further `perl-base` CVE, CVE-2026-9538, is `fix_deferred` on both Debian 12 and
13. It has no fixed version, so it never blocked the gate, and it stays visible.

## When to Apply

- An automated report or audit flags `trivy/release-image` alerts as outstanding
- Trivy reports OS package CVEs with no fixed version
- Someone proposes a base-image swap to clear inherited findings
- The enforcement pass fails because a fixable base-image CVE appeared
- Planning a runtime base upgrade for reasons other than these alerts

## Examples

### The parsing trap

Alert bodies put `Fixed Version:` on its own line, empty, followed by `Link:`.
Because `\s` matches newlines, a naive regex captures the *next* line and makes
every unfixed finding look fixed:

```js
// WRONG — \s crosses the newline and captures the following "Link:" line,
// so every alert appears to have a fix.
const wrong = /Fixed Version:\s*(.*)/

// RIGHT — [^\S\n] is horizontal whitespace only, so the capture stops
// at the line end and correctly yields an empty string.
const right = /Fixed Version:[^\S\n]*([^\n]*)/
```

Count fix availability explicitly before drawing any conclusion:

```sh
gh api repos/fro-bot/dashboard/code-scanning/alerts --paginate
```

### What a further base swap would and would not buy

Distroless is deferred, not rejected. It removes the Debian OS package findings
by omitting those packages and measured about 170 MB as a built image that booted
successfully with HTTP 302, but it is not a one-line swap. Distroless has no
`node` account while deployment pins `user: node`. Making it work requires
coordinated changes in `marcusrbrown/infra` to Compose `user:`,
`install -d -o 1000 -g 1000`, the recursive `chown`, the post-deploy `stat`
assertion that requires `1000:1000:700:directory`, and the mounted GitHub App
PEM's `1000:1000:0600` ownership — against a live droplet whose deploy fails
closed on drift.

Alpine is ruled out for a runtime-only swap. The `prod-deps` stage compiles
native modules (`@swc/core` and `unrs-resolver`, allowed by
`pnpm-workspace.yaml` `allowBuilds`) against glibc and copies `node_modules/`
into the runtime stage. Moving only the runtime stage to musl would not work;
all stages and native-module builds would have to move together.

The distroless comparison scan was built on arm64 because
`--platform linux/amd64` segfaulted under qemu during `pnpm build:web` with
`qemu: uncaught target signal 11`. CI publishes amd64. Package sets should be
near-identical, but this is not a byte-exact reproduction of the CI image.

## When to revisit

- A `Fixed Version:` appears for a remaining alert. The enforcement scan will
  then correctly fail the release until the package is updated.
- The coordinated distroless UID and deployment changes become worth the
  operational cost in `marcusrbrown/infra`.

## Related

- `docs/solutions/workflow-issues/release-paths-filter-must-cover-runtime-image-contents-2026-06-25.md`
  — the other place release-gate configuration and runtime image contents have
  to be reasoned about together.
- `docs/solutions/security-issues/cross-source-redaction-denylist-before-query-2026-06-15.md`
  — fail-closed security handling in the same module.
- `docs/solutions/security-issues/github-app-credential-domain-conflation-2026-06-15.md`
  — adjacent least-privilege boundary lesson.
- A sibling finding from the same investigation: the image declared uid 1001
  while Compose pinned `user: node` (uid 1000), so the declared user was
  exercised only by the release smoke test and left the standalone image unable
  to write its data volume. Fixed in PR #406 by changing `Dockerfile` to
  `USER node` and updating the smoke assertion to expect 1000. The host data
  directory was already `1000:1000` and did not change, which is why aligning
  the image was the cheap direction.
