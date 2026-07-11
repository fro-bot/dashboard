---
type: contract
status: active
date: 2026-07-11
consumers: [dashboard operator UI]
producers: [marcusrbrown/infra, fro-bot/agent]
---

# Operator Listener Channel — wire contract

The listener channel is a single operator-facing surface in the dashboard where
machine producers post findings and reports. It replaces the machine-to-machine
GitHub issue flow: infra's deploy-health / autoheal findings and the agent's
Daily Maintenance Report land here instead of as issues.

Two producers, one consumer:

- **Producers** (machine, write-only): `marcusrbrown/infra` workflows and
  `fro-bot/agent`'s scheduled run. They authenticate with a shared HMAC key and
  `POST` messages.
- **Consumer** (operator, read + ack): the dashboard operator PWA. It reads
  messages over the existing session-cookie auth and marks them read.

This document is the authoritative contract. Producer migrations are dispatched
against it as separate tasks; do not change the wire shape without updating this
file.

## Transport summary

| Path | Method | Auth | Caller |
| --- | --- | --- | --- |
| `/api/listener/ingest` | `POST` | HMAC shared key | Producers |
| `/api/listener/messages` | `GET` | Session cookie | Operator UI |
| `/api/listener/messages/:id/ack` | `POST` | Session cookie | Operator UI |
| `/api/listener/ack-all` | `POST` | Session cookie | Operator UI |

The machine-write surface (`/api/listener/ingest`) and the operator-read surface
(`/api/listener/messages*`) are deliberately separate paths with separate auth
domains: the ingest path is public-before-session and HMAC-gated; the read/ack
paths sit behind the operator session. They never share a path or fall back to
each other's auth.

The read side is **polled** by the operator UI (same fetch + interval pattern as
the runs index). There is no server-push transport; a machine finding becomes
visible on the next poll.

## Ingestion — `POST /api/listener/ingest`

Machine producers authenticate every request with an HMAC-SHA256 signature over
the exact request body and a timestamp. No GitHub identity, no session cookie.

### Headers

| Header | Value |
| --- | --- |
| `content-type` | `application/json` |
| `x-listener-timestamp` | Unix seconds, integer, as a string |
| `x-listener-signature` | `sha256=<hex>` |

### Signature

```text
signature = HMAC_SHA256(key = DASHBOARD_LISTENER_INGEST_KEY,
                        message = `${x-listener-timestamp}.${rawRequestBody}`)
x-listener-signature = "sha256=" + hex(signature)
```

- The signed message is the timestamp, a literal `.`, then the **raw UTF-8
  request body bytes** — sign the exact bytes you send, before any reformatting.
- The server recomputes over the raw body it received and compares in constant
  time. Any mismatch is a `401` with no detail.
- The timestamp must be within **±300 seconds** of server time, else `401`
  (replay window). Producers should send the same timestamp they signed.

### Request body

Producers send the content fields only. The server assigns `id` and
`receivedAt`; any client-supplied `id`/`receivedAt` is ignored.

```jsonc
{
  "source": "infra", // "infra" | "agent" (required)
  "kind": "deploy-health", // slug, required; [a-z0-9-], <=64 chars
  "severity": "warning", // "info" | "warning" | "critical" (required)
  "title": "Autoheal restarted gateway", // required, <=200 chars
  "body": "gateway health probe failed 3x; container restarted and recovered.",
  // required, plain text, <=8192 bytes
  "links": [ // optional, <=10 items
    {"label": "workflow run", "url": "https://github.com/marcusrbrown/infra/actions/runs/123"}
  ],
  "dedupeKey": "deploy-health-2026-07-11", // optional, <=128 chars
  "createdAt": "2026-07-11T12:00:00Z" // required, ISO-8601 (producer clock)
}
```

Field rules (validated server-side, fail-closed):

- `source` — must be exactly `infra` or `agent`.
- `kind` — lowercase slug, `^[a-z0-9-]{1,64}$`. Suggested values:
  `deploy-health`, `autoheal`, `daily-maintenance-report`.
- `severity` — one of `info`, `warning`, `critical`.
- `title` — trimmed, 1..200 chars.
- `body` — trimmed, 1..8192 bytes (UTF-8). Plain text; the UI does not render
  HTML or Markdown.
- `links[].label` — 1..80 chars. `links[].url` — must be `https://` (other
  schemes rejected).
- `dedupeKey` — optional. See idempotency below.
- `createdAt` — ISO-8601 with timezone. Used for display; the server stamps its
  own `receivedAt` for ordering and retention.

### Idempotency

If `dedupeKey` is present, `(source, dedupeKey)` is unique. A second POST with
the same pair **updates the existing message in place** (title/body/severity/
links/createdAt refreshed, `id` preserved) and resets it to unread. This keeps a
recurring producer — e.g. a Daily Maintenance Report keyed on the run date —
from stacking duplicates. Without a `dedupeKey`, every POST is a new message.

### Responses

| Status | Meaning | Body |
| --- | --- | --- |
| `202 Accepted` | Stored (inserted or upserted) | `{ "id": "...", "receivedAt": "..." }` |
| `400 Bad Request` | Schema violation | `{ "error": "<fixed reason>" }` |
| `401 Unauthorized` | Bad/missing/expired signature | `{ "error": "unauthorized" }` |
| `413 Payload Too Large` | Body over cap | `{ "error": "payload too large" }` |
| `429 Too Many Requests` | Rate limited | `{ "error": "rate limited" }` |

Error bodies never echo request content (no leak of a signed payload or a repo
identity in an error string).

## Read — `GET /api/listener/messages`

Session-authenticated (the operator's signed `session` cookie, same as the rest
of the dashboard). Query params:

- `unreadOnly` — `true` returns only unread messages. Default `false`.
- `limit` — 1..200, default 100. Newest first by `receivedAt`.

Response:

```jsonc
{
  "messages": [
    {
      "id": "b2b1...",
      "source": "infra",
      "kind": "deploy-health",
      "severity": "warning",
      "title": "Autoheal restarted gateway",
      "body": "...",
      "links": [{"label": "workflow run", "url": "https://..."}],
      "createdAt": "2026-07-11T12:00:00Z",
      "receivedAt": "2026-07-11T12:00:01Z",
      "read": false
    }
  ],
  "unreadCount": 3
}
```

## Ack — `POST /api/listener/messages/:id/ack` and `POST /api/listener/ack-all`

Session-authenticated. Marks one message (or all) read. Read state is durable
and server-side, so unread status is consistent across the operator's desktop
and phone.

- `POST /api/listener/messages/:id/ack` → `202` `{ "id": "...", "readAt": "..." }`,
  or `404` if the id is unknown.
- `POST /api/listener/ack-all` → `202` `{ "acked": <count> }`.

## Persistence and retention

Messages are stored in SQLite (`node:sqlite`, no external dependency) on the
persistent `/data` volume. Location is `DASHBOARD_LISTENER_DB` (default
`/data/listener/messages.db`).

Retention is enforced on every write:

- Keep at most **500** messages, and
- drop messages older than **30 days** by `receivedAt`,

whichever removes more. Read state is a column on the message row, so it is
pruned with the row.

## Configuration

| Env | Meaning | Default |
| --- | --- | --- |
| `DASHBOARD_LISTENER_INGEST_KEY` | Shared HMAC key for ingestion. Also accepts `..._FILE`. | required to enable ingestion |
| `DASHBOARD_LISTENER_DB` | SQLite file path | `/data/listener/messages.db` |

If `DASHBOARD_LISTENER_INGEST_KEY` is not set, the ingestion route is not
mounted and returns `404` — the read/ack side and UI still work (empty channel).
The key is a shared secret between the dashboard and each producer; it is never
the dashboard cookie key and never a GitHub token.

## Security posture

- Ingestion trusts only the HMAC signature, verified in constant time over the
  raw body, inside a bounded replay window. It carries no GitHub identity.
- The ingestion key is a distinct credential domain from the dashboard session
  cookie and from any GitHub App key. It is provisioned to producers as a
  repository/environment secret.
- The read/ack side is behind the existing session auth; a machine producer
  cannot read or ack, only write.
- Message content is operator-authored/machine-authored operational text and is
  rendered as plain text — no HTML/Markdown execution, `https://` links only.

## Producer integration (dispatched separately)

What each producer needs to do, against this contract:

1. Obtain `DASHBOARD_LISTENER_INGEST_KEY` (shared secret) as a CI secret.
2. Build the JSON body, capture the raw bytes.
3. Compute `x-listener-timestamp` (unix seconds) and
   `x-listener-signature = "sha256=" + hex(HMAC_SHA256(key, ` `${ts}.${rawBody}` `))`.
4. `POST` to `https://dashboard.fro.bot/api/listener/ingest` with the three
   headers and the raw body.
5. Treat `202` as success. On `401`/`5xx`, retry with backoff; do not fall back
   to opening a GitHub issue once migrated.

- **`marcusrbrown/infra`** — replace the deploy-health / autoheal issue-open
  step. `source: "infra"`, `kind: "deploy-health" | "autoheal"`.
- **`fro-bot/agent`** — replace the Daily Maintenance Report issue-open step.
  `source: "agent"`, `kind: "daily-maintenance-report"`,
  `dedupeKey` keyed on the run date so a re-run updates rather than duplicates.
