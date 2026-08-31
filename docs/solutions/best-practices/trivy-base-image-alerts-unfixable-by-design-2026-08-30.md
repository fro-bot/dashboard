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
tags:
  - trivy
  - docker
  - debian
  - base-image
  - unfixed-cves
  - release-gate
  - distroless
---

# Base-image Trivy alerts are unfixable by design

## Context

An automated daily report flagged "33 Trivy base-image CVEs, several critical" as
an outstanding security gap. The framing was wrong, and re-deriving that each
time the report runs is pure cost.

Code scanning shows 37 open Trivy alerts in the `trivy/release-image` category:
4 CRITICAL, 29 HIGH, 2 medium, 2 low. They collapse to 14 unique CVEs inherited
from Debian OS packages in the base image.

| Package family | CVEs | Count |
| --- | --- | ---: |
| `perl-base` | CVE-2026-13221, CVE-2026-42496, CVE-2026-8376, CVE-2026-42497, CVE-2026-48962, CVE-2026-57432, CVE-2026-57433, CVE-2026-9538 | 8 |
| `util-linux` family (`util-linux`, `util-linux-extra`, `mount`, `libuuid1`, `libsmartcols1`, `libmount1`, `libblkid1`, `bsdutils`) | CVE-2026-53613, CVE-2026-53615 | 2 |
| `zlib1g` | CVE-2023-45853 | 1 |
| `ncurses` family (`ncurses-base`, `ncurses-bin`, `libtinfo6`) | CVE-2025-69720 | 1 |
| `libacl1` | CVE-2026-54369 | 1 |
| `gzip` | CVE-2026-41992 | 1 |

Every alert body has an empty `Fixed Version:` field. There is no upstream
package version to move to.

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
  -D- -o /dev/null "https://registry-1.docker.io/v2/library/node/manifests/24-slim" \
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
these alerts open.

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
Dockerfile solely to reduce the alert count.

## When to Apply

- An automated report or audit flags `trivy/release-image` alerts as outstanding
- Trivy reports OS package CVEs with no fixed version
- Someone proposes a base-image swap to clear inherited findings
- Planning a runtime base upgrade for reasons other than these alerts

## Examples

### The parsing trap

Alert bodies put `Fixed Version:` on its own line, empty, followed by `Link:`.
Because `\s` matches newlines, a naive regex captures the *next* line and makes
every unfixed finding look fixed:

```js
// WRONG — \s crosses the newline and captures the following "Link:" line,
// so all 37 alerts appear to have a fix.
const wrong = /Fixed Version:\s*(.*)/

// RIGHT — [^\S\n] is horizontal whitespace only, so the capture stops
// at the line end and correctly yields an empty string.
const right = /Fixed Version:[^\S\n]*([^\n]*)/
```

Count fix availability explicitly before drawing any conclusion:

```sh
gh api repos/fro-bot/dashboard/code-scanning/alerts --paginate
```

For this image the answer was 0 fixable out of 37.

### What a base swap would and would not buy

Each alternative below was scanned as an actual built image, and each booted
successfully with HTTP 302:

| Runtime base | CRITICAL | HIGH | Size | Of the 14 CVEs |
| --- | ---: | ---: | ---: | --- |
| `node:24-slim` (current) | 4 | 26 | 264 MB | all 14 present |
| `node:24-trixie-slim` | 3 | 12 | 275 MB | 11 remain |
| `gcr.io/distroless/nodejs24-debian12:nonroot` | 1 | 5 | 170 MB | 0 remain |

Trixie is a half-measure. It clears only 3 of 14 — the `zlib1g` finding and the
two `util-linux` findings. All 8 `perl-base` CVEs survive, including 3 of the 4
criticals; Debian 13 ships `perl-base 5.40.1-6` and those CVEs remain unfixed
there. It costs 11 MB more for a marginal reduction.

Distroless is deferred, not rejected. It removes all 14 by omitting those
packages and cuts the image to 170 MB, but it is not a one-line swap. Distroless
has no `node` account while deployment pins `user: node`. Making it work
requires coordinated changes in `marcusrbrown/infra` to Compose `user:`,
`install -d -o 1000 -g 1000`, the recursive `chown`, the post-deploy `stat`
assertion that requires `1000:1000:700:directory`, and the mounted GitHub App
PEM's `1000:1000:0600` ownership — against a live droplet whose deploy fails
closed on drift.

Alpine is ruled out for a runtime-only swap. The `prod-deps` stage compiles
native modules (`@swc/core` and `unrs-resolver`, allowed by
`pnpm-workspace.yaml` `allowBuilds`) against glibc and copies `node_modules/`
into the runtime stage. Moving only the runtime stage to musl would not work;
all stages and native-module builds would have to move together.

The comparison scans were built on arm64 because `--platform linux/amd64`
segfaulted under qemu during `pnpm build:web` with `qemu: uncaught target signal
11`. CI publishes amd64. Package sets should be near-identical, but this is not
a byte-exact reproduction of the CI image.

### Root cause of the unfixability

`node:24-slim` resolves to Debian 12 bookworm, now oldstable with LTS-only
security support:

```text
perl-base 5.36.0-7+deb12u3
util-linux 2.38.1-5+deb12u3
zlib1g 1:1.2.13.dfsg-1
```

The pinned digest
`sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e`
matches the current published `node:24-slim`. There is no newer digest to move
to.

## When to revisit

- A `Fixed Version:` appears for one of these alerts. The enforcement scan will
  then correctly fail the release until the package is updated.
- `node:24-slim` moves to trixie upstream, changing the support window and
  package set.
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
