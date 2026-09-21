# Gateway Access

The dashboard's operator surface is not served by this app. `https://dashboard.fro.bot/operator/*`
is proxied by Caddy to a gateway running `fro-bot/agent`, and that gateway owns operator auth,
sessions, and push. When operator login or push misbehaves, the evidence is in the gateway's logs,
not this repository's — and no test here can reach it.

This runbook covers getting to that evidence. Every trap below cost real time during a production
outage, so read them before improvising a command.

---

## Prerequisites

- A local checkout of `marcusrbrown/infra` with its repo-root `.env` (holds `GATEWAY_HOST`). The
  CLI below is that repo's, and commands run from its root so Bun loads `.env` automatically.
- An SSH key in your agent that the droplet accepts. In local mode the CLI passes no `-i` flag and
  relies on `SSH_AUTH_SOCK`.

Without the infra checkout you cannot read gateway logs. That is the honest boundary: debugging an
operator-auth or push problem from this repository alone is not possible past the proxy.

---

## Prefer the CLI

```sh
bunx @marcusrbrown/infra gateway status              # docker compose ps, service states
bunx @marcusrbrown/infra gateway logs gateway --tail 200
bunx @marcusrbrown/infra gateway deploy              # triggers the Deploy Gateway workflow
```

`gateway logs <service>` takes `gateway`, `caddy`, `mitmproxy`, or `workspace`.

**There is no `gateway restart` subcommand.** The full list is `status`, `deploy`, `logs`,
`backup`, `restore`. Restarting one service requires SSH.

`gateway deploy` runs in CI with the real credentials and stops at the `gateway` environment
approval gate, which only the owner can approve.

---

## Direct SSH

```sh
GATEWAY_HOST=$(grep -m1 '^GATEWAY_HOST=' .env | cut -d= -f2-)
ssh -o BatchMode=yes -o ConnectTimeout=10 root@"$GATEWAY_HOST" \
  "cd /opt/gateway/deploy && docker compose ps"
```

Two details do all the work, and both are easy to get wrong:

- **The remote user is `root`**, not your local username (`DEFAULT_REMOTE_USER`,
  `apps/gateway/src/deploy.ts:192` in `marcusrbrown/infra`).
- **Compose lives in `/opt/gateway/deploy`**, not `/opt/gateway` (`DEPLOY_DIR`,
  `apps/gateway/src/deploy.ts:187`). `/opt/gateway` is the repo checkout.

---

## Restart a single service

```sh
ssh root@"$GATEWAY_HOST" "cd /opt/gateway/deploy && docker compose restart gateway"
bunx @marcusrbrown/infra gateway status
```

This drops everything the gateway holds in memory: operator browser sessions and the OAuth state
store. Sometimes that is the point — a saturated OAuth attempt cap clears instantly, where
otherwise it waits out a 10-minute TTL. It also forces every operator to sign in again.

Never restart in place to rotate the mitmproxy CA — workspaces lose trust in the egress proxy.
Restore from backup instead.

---

## Traps

**Wrong remote user.** `ssh "$GATEWAY_HOST"` uses your local username. With several keys in your
agent this reports `Received disconnect … Too many authentication failures`, not
`Permission denied` — the server cuts off before reaching a usable key. The message sends you
hunting for the right key when the username is wrong. Always specify `root@`.

**Stop after two failed auth attempts.** Repeated failures risk tripping fail2ban and locking
everyone out, which is worse than whatever you were debugging.

**Never `source` the infra repo's `.env`.** It contains multiline SSH keys; `set -a; . ./.env`
throws parse errors and corrupts the environment. Extract single values with `grep`/`cut`.

**`GATEWAY_SSH_KEY` will not authenticate you interactively.** It is materialized to a temp file
and used with `-i` only under `CI=true`.

**Wrong compose directory** gives `no configuration file provided: not found`, which reads like a
missing file rather than a wrong path.

**Logs are sensitive.** The CLI prints a warning for a reason — output can carry Discord tokens,
S3 credentials, and user data. Never paste it into an issue, PR, or commit message. Extract the
fields you need and delete the capture.

---

## Reading logs effectively

Lines are JSON with a `msg` field. Counting message shapes beats reading sequentially:

```sh
bunx @marcusrbrown/infra gateway logs gateway --tail 300 > /tmp/gw.log
grep -oE '"msg":"[^"]{0,80}"' /tmp/gw.log | sort | uniq -c | sort -rn | head -20
```

Audit events appear as `audit: <kind>` — `auth.start`, `auth.callback.success`,
`auth.callback.failure`, `push.subscribed`, `push.unsubscribed`, `push.dispatch`, `push.disabled`.

**The discriminator worth memorizing:** a `start` event with **neither** a success nor a failure
following it means the handler never ran — look upstream at proxying, rate limits, or redirects. A
`start` followed by a failure means it ran and rejected — look inside it. That distinction is what
identified the outage recorded in
`docs/solutions/security-issues/gateway-operator-oauth-rate-limit-shared-key-behind-caddy-2026-09-21.md`.

Delete the capture when done; it is sensitive.
