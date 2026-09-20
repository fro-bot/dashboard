# Privacy policy claims

`claims.ts` holds the structured facts the public `/privacy` page states about
the Gateway-owned push surface. `web/privacy.html` renders the prose;
`content.test.ts` binds the two, so a disclosure cannot be dropped from the page
without failing a test.

The facts describe behavior implemented in `fro-bot/agent`, not in this
repository. Re-survey that source before changing a claim.

## Public-page safety

`claims.ts` compiles into an unauthenticated page. Values are data categories
only — never endpoints, key material, route or storage paths, or account
identifiers. `claims.test.ts` enforces this with a negative sweep.

## Why these claims and not the issue body

`fro-bot/dashboard#238` lists required policy content, but a survey of the
Gateway source found that list inaccurate: it omits the ownership-generation
field and the tombstone retention class, describes VAPID rotation as
deactivating subscriptions when rotation only suppresses stale-key delivery,
understates audit event contents, and implies a standalone export endpoint that
does not exist.

Two items the first survey could not confirm were resolved before any copy was
written, because omitting a real processing activity is itself a compliance
problem:

- There is no export or data-subject-access endpoint. The subscription metadata
  listing is the only read surface. The page states this as an explicit
  negative rather than staying silent.
- Relay choice belongs to the browser, not the Gateway — there is no vendor
  allowlist. The page discloses the recipient category and says so.
