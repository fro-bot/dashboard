---
title: Cross-source redaction — denylist before query, cross-format key, fail closed
date: 2026-06-15
category: security-issues
module: dashboard
problem_type: security_issue
component: service_object
symptoms:
  - "a repo redacted in metadata is re-derivable via installation enumeration with its real name"
  - "filtering at render time still issues a status query for the redacted repo (leak of intent)"
  - "node_id format skew between channels bypasses an exact-string denylist"
  - "a denylist read failure could produce an unfiltered union instead of failing closed"
root_cause: missing_validation
resolution_type: code_fix
severity: high
related_components:
  - src/github/metadata.ts
  - src/github/aggregator.ts
  - src/server.ts
tags:
  - redaction
  - denylist
  - fail-closed
  - cross-format-key
  - leak-of-intent
  - node-id
---

# Cross-source redaction — denylist before query, cross-format key, fail closed

## Problem

A monitoring app reads a redaction-aware metadata file (private repos intentionally
redacted) **and** enumerates GitHub App installations, which can see those same
private repos with their real names. Without a structural guard, the installations
channel re-derives what redaction hid. Filtering late is not enough: issuing a
status query against a redacted repo is itself an observable leak of intent.

## Symptoms

- A repo redacted in metadata still appears (real name) through installation
  enumeration.
- Filtering at render time still sends a per-repo status query for the redacted
  repo — the query is the leak.
- Exact `node_id` matching misses the same repo when the two channels expose
  different node-id formats (legacy `MDEw...` vs new `R_kgDO...`).

## What Didn't Work

- **Filtering at render time** — too late; the query already leaked intent.
- **Matching by `node_id` alone** — format skew bypasses exact-string matching.
- **Adding a `database_id` denylist that was always empty** — the metadata file
  carries no numeric id, so the cross-format guard was a no-op until the numeric id
  was *derived* from the node_id.

## Solution

Exclude denylisted repos **before** the per-repo query loop, match on a
format-stable key, and fail closed when the denylist is unusable.

Reader builds both deny keys and refuses any redacted entry it cannot denylist:

```ts
if (!hasValidNodeId && !hasValidDatabaseId) {
  logger.error('Redacted/private repos.yaml entry has no usable deny key — failing closed')
  return err(new MetadataSchemaError(
    `${METADATA_PATH}: redacted/private entry has no usable deny key`,
  ))
}
const derivedId = deriveDatabaseId(nodeIdStr) // decode numeric id from either node_id format
if (derivedId !== null) redactedDatabaseIds.add(derivedId)
```

Exclusion happens upstream of any query, matching node_id **or** databaseId:

```ts
// buildWorkingSet — runs before the per-repo fetch loop
if (redactedNodeIds.has(repo.node_id) || redactedDatabaseIds.has(repo.database_id)) {
  continue
}
```

Every metadata failure mode fails closed (never an unfiltered union):

```ts
return err(new MetadataUnavailableError(/* 404 / data branch missing */))
return err(new MetadataParseError(/* malformed YAML */))
return err(new MetadataSchemaError(/* wrong version / no deny key */))
return err(new MetadataTransportError(/* network */))
// aggregator: on any metadata err → serve last-good + stale banner, or empty; never build a fresh union
```

## Why This Works

- Excluding before the query removes the leak-of-intent entirely — no observable
  signal is ever emitted for a redacted repo.
- `database_id` is format-stable, so it catches node-id skew across channels.
- Fail-closed guarantees that *absence* of the denylist can never silently degrade
  into *exposure*.

## Prevention

- Assert the GraphQL client is **never called** for a denylisted id — test the
  absence of the query, not just absence from output.
- Cross-format fixture: different `node_id`, same `database_id` → excluded.
- Fail-closed tests for every metadata error variant (404 / parse / schema /
  transport) and for a redacted entry with no usable deny key.
- Require every redacted entry to contribute a usable deny key, or stop.

## Related Issues

- Source: fro-bot/dashboard PR #10 (monitoring dashboard core).
- Reinforces `AGENTS.md` → "Critical security invariants" (redaction preservation).
- Companion learning: `github-app-credential-domain-conflation-2026-06-15.md`.
- See `src/github/metadata.ts` (reader, fail-closed taxonomy) and
  `src/github/aggregator.ts` (denylist-before-query enforcement).
