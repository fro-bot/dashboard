---
title: GitHub App auth — App JWT vs per-installation token vs repo→installation ownership
date: 2026-06-15
category: security-issues
module: dashboard
problem_type: security_issue
component: authentication
symptoms:
  - "metadata repo-contents reads failed in production but passed mocked tests"
  - "GraphQL status queries for repos in installation 2+ silently failed or showed stale"
  - "only the first installation's token was minted for a multi-installation working set"
  - "App JWT was used for repo contents instead of an installation token"
root_cause: wrong_api
resolution_type: code_fix
severity: high
related_components:
  - src/server.ts
  - src/github/app-client.ts
  - src/github/installations.ts
  - src/github/aggregator.ts
tags:
  - github-app
  - installation-token
  - app-jwt
  - auth-domain
  - per-installation
  - leak-prevention
---

# GitHub App auth — App JWT vs per-installation token vs repo→installation ownership

## Problem

GitHub App authentication was modeled as one global transport. It isn't. There are
three distinct authorization domains, and conflating them used the wrong credential
on repo reads and status queries. The bug surfaced across **three** PR review rounds
because each earlier fix addressed a symptom, not the auth model.

The three credentials:

1. **App JWT** — app identity + installation *discovery* only. Valid for `/app/*`
   and `GET /repos/{owner}/{repo}/installation`. **Not** valid for repo contents or
   repo GraphQL.
2. **Per-installation token** — required for repo contents
   (`GET /repos/.../contents`), `GET /installation/repositories`, and repo GraphQL.
3. **repo → installation ownership** — *which* installation authorizes a given repo.
   In a multi-installation app this is a per-repo property and must travel with the
   repo.

## Symptoms

- The metadata reader used the App-JWT Octokit to `GET /repos/.../contents`. It
  passed every mocked test but fails in production — the App JWT cannot read repo
  contents.
- GraphQL status queries minted a token for only the **first** installation, so
  repos reachable only through installation #2+ came back stale/failed.
- All mocked unit tests passed because the mocks did not distinguish App JWT vs
  installation token vs installation ownership.

## What Didn't Work

Three sequential symptom-patches, each green locally, each followed by a new auth
failure in the next review round:

1. Fix installation pagination.
2. Wire the data layer into the running server.
3. Unify log redaction.

The lesson: **when the same surface fails review repeatedly, stop patching symptoms
and do a root-cause architectural pass.** The fourth attempt — modeling the
credential domains explicitly — closed the class.

## Solution

Carry `installation_id` end-to-end and mint a read-only token *at the point of use*
for the installation that owns the repo.

Resolve a repo's installation with the one repo endpoint the App JWT is valid for:

```ts
const resolveInstallationIdForRepo = async (owner: string, name: string): Promise<number> => {
  const response = await appClient.octokit.request('GET /repos/{owner}/{repo}/installation', {
    owner,
    repo: name,
  })
  return (response.data as unknown as {id: number}).id
}
```

Metadata read uses an **installation** token, not the App JWT:

```ts
const installationId = await resolveInstallationIdForRepo('fro-bot', '.github')
const token = await getReadOnlyToken(installationId)
const installOctokit = new Octokit({auth: token})
const response = await installOctokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
  owner: 'fro-bot', repo: '.github', path, ref,
})
```

GraphQL takes the installation id per call — no "first installation":

```ts
const graphqlQueryFn = async (installationId: number, query: string, variables: Record<string, unknown>) => {
  const token = await getReadOnlyToken(installationId)
  return graphql.defaults({headers: {authorization: `token ${token}`}})(query, variables)
}
```

`installation_id` travels with each repo from enumeration through the working set:

```ts
reposByNodeId.set(repo.node_id, {...repo, installation_id: installation.id})
// ...later, in the aggregator fetch loop:
await graphqlQueryForInstallation(entry.installation_id, REPO_STATUS_QUERY, vars)
```

Read-only is enforced at the type boundary so write/admin is unrepresentable:

```ts
async function mintInstallationToken(
  installationId: number,
  permissions: Record<string, 'read'>,
): Promise<string> { /* ... */ }
```

## Why This Works

- The App JWT authorizes only app identity and installation discovery.
- Repo contents and repo GraphQL require the installation's own token.
- In a multi-installation app the authorizing installation is a property of the
  repo, so it must travel with the repo rather than being guessed at call time.

## Prevention

- Test with a fake App-JWT client that **rejects** repo/content/GraphQL endpoints —
  this forces installation-token usage and fails if anyone reverts to the App JWT.
- Use a 2-installation fixture where a repo from installation #2 must be queried
  with installation #2's token.
- Keep installation-token permissions typed as `Record<string, 'read'>`.
- Route all minting through one read-only seam (cache + optional-scope fallback);
  never mint directly from server/wiring code.
- Mocks must distinguish credential types, or they will keep hiding this bug class.

## Related Issues

- Source: fro-bot/dashboard PR #10 (monitoring dashboard core).
- Reinforces `AGENTS.md` → "Critical security invariants" (read-only by construction).
- Companion learning: `cross-source-redaction-denylist-before-query-2026-06-15.md`.
- See `src/github/app-client.ts` (App JWT vs installation token split).
