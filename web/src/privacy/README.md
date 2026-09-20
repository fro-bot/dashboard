Source: fro-bot/agent | Surveyed tag: v0.113.2 | Verified: 2026-09-19
Deployed pin: v0.93.1 (per `marcusrbrown/infra` `apps/gateway/upstream.json`)

`claims.ts` is the single stamped source of truth for every factual claim the
public `/privacy` page (added in a later unit) makes about operator Web Push
behavior. This README is not bundled into the client build — it exists to
record internal specifics `claims.ts` deliberately omits (route names,
storage/schema specifics) so a future drift check (plan Unit 6, not yet
implemented) has something to diff the live Gateway against.

Do not hand-edit `claims.ts` to describe behavior without re-surveying the
Gateway source at a specific tag and updating `CLAIMS_SOURCE` and this file
together.

## Why this exists

`fro-bot/dashboard#238` specifies the required policy content, but research
against the `fro-bot/agent` source at v0.113.2 found that spec materially
inaccurate: it omits stored fields (the ownership-generation counter) and a
whole retention class (the tombstone), misstates VAPID rotation as
deactivating subscriptions (it doesn't — see below), understates audit event
contents, and asserts an export surface that could not be confirmed either
way. Publishing the issue body as written would ship false privacy
representations. `claims.ts` replaces it as the actual source for page copy.

## What was surveyed

Gateway push subscription lifecycle at `fro-bot/agent@v0.113.2`:

- The stored subscription record shape (fields, not just the safe-projection
  DTO already vendored in `src/gateway/operator-contract/push.ts`).
- The safe-metadata read projection actually returned to operators
  (`PushSubscriptionMetadata` in `src/gateway/operator-contract/push.ts` is
  the dashboard's existing vendored copy of this same projection — this
  artifact's `readSurfaceProjection` claim must stay consistent with it).
- Deactivation trigger set, including ownership transfer (the issue spec
  omitted this trigger).
- Retention configuration: inactive-record retention and deletion-tombstone
  retention are two separate, independently configurable values. The issue
  spec conflated them into one.
- Deletion behavior: tombstone contents, physical removal, and the
  re-subscribe-clears-tombstone path.
- Audit event contents: event kind, correlation identifier, and per-event-type
  payload (operator identifier, coarse reason, trigger label, counts).
- VAPID rotation semantics: current/previous key still deliverable, older
  keys skipped as stale until re-registration, no deactivation or deletion
  as a rotation side effect. The issue spec states rotation deactivates
  subscriptions — this is not what the source does.
- Payload construction: fixed neutral copy plus an allowlisted failure-label
  set, with the exclusion list (no repo names, prompts, run IDs, output,
  endpoints, keys, tokens, cookies, session data).
- Relay-facing behavior: the browser-chosen endpoint determines the vendor
  push service. The Gateway sets no TTL, urgency, or topic option itself, but
  the dispatch library supplies defaults, so every request still carries a
  TTL and an urgency value (see the resolution below).

## Previously unresolved items — both now resolved

The first survey left two items open. A privacy notice that omits a real
processing activity is itself a compliance failure, so both were treated as
release blockers and resolved before the page content was written. Neither
remains an `UnverifiedClaim`; `claims.test.ts` now asserts that none do.

- **Standalone subscription-export HTTP route — RESOLVED, absent.** A full
  enumeration of the operator-push surface at the pinned tag found exactly
  four routes: VAPID public-key read, subscription create/replace,
  subscription unsubscribe, and subscription metadata listing. None is an
  export, download, or data-subject-access endpoint, and no export surface
  exists elsewhere in the Gateway. The issue spec's "export returns metadata
  only" implies a capability that does not exist as a distinct surface.
  `claims.ts` now states this as an explicit negative (`exportSurface`) rather
  than staying silent, because silence would imply the capability.
- **Relay vendor mix — RESOLVED as a recipient category.** Still not a
  telemetry question: the subscribe and dispatch paths contain no vendor
  allowlist, fixed-origin comparison, or vendor-specific branch, so the
  concrete vendor is chosen per subscription by the browser. Endpoint
  validation is a transport/network-safety filter (HTTPS required; loopback,
  private, and link-local ranges rejected), not a vendor restriction.
  Disclosed as a category (`relayVendors`) naming the major browser push
  providers, with an explicit statement that this service keeps no fixed list.

### Dispatch-library defaults (load-bearing for the relay claim)

The Gateway depends on `web-push@3.6.7` and passes only VAPID details, a
timeout, and its guarded HTTPS agent. The library's own defaults therefore
apply: TTL `2419200` seconds (four weeks), urgency `normal`, and no topic.
Those headers are sent on every delivery request and are visible to the relay.

An earlier draft of `relayProcessing` said the Gateway "sets no explicit TTL,
urgency, or topic header" — literally true, and misleading, because it implies
the relay sees no such metadata. If the dispatch library version changes, these
defaults must be re-checked and the relay claim re-worded.

## Where each `claims.ts` entry came from

| Claim key | Category | Source |
|---|---|---|
| `storedSubscriptionFields` | stored-fields | Gateway subscription record shape, fro-bot/agent@v0.113.2 |
| `readSurfaceProjection` | read-surface | Gateway safe-metadata response; matches the dashboard's vendored `PushSubscriptionMetadata` (`src/gateway/operator-contract/push.ts`) |
| `deactivationReasons` | deactivation | Gateway deactivation trigger set, fro-bot/agent@v0.113.2 |
| `inactiveRetention` | retention | Gateway inactive-record retention default (30 days, configurable) |
| `tombstoneRetention` | retention | Gateway tombstone retention default (90 days, configurable), tracked separately from inactive retention |
| `deletionBehavior` | deletion | Gateway deletion/tombstone code path |
| `auditEvents` | audit | Gateway audit event emission for subscribe/unsubscribe/deactivation/dispatch/push-disabled |
| `vapidRotation` | vapid-rotation | Gateway key-rotation dispatch logic (stale-key suppression, not deactivation) |
| `relayProcessing` | relay | Gateway dispatch call to the browser-chosen push endpoint, plus `web-push@3.6.7` default TTL/urgency headers |
| `payloadContents` | payload | Gateway notification payload construction |
| `exportSurface` | export-surface | Full route enumeration of the operator-push surface — explicit negative, no export endpoint exists |
| `relayVendors` | relay | Absence of any vendor allowlist or vendor-specific branch in the subscribe/dispatch paths |

## Internal specifics for the drift check

Deliberately kept out of `claims.ts` (which compiles into a public page) and
recorded here so plan Unit 6 has concrete things to diff.

- **Stored record fields:** endpoint hash, endpoint, P-256 public key, auth
  secret, operator id, active flag, key version, ownership generation, created
  timestamp, updated timestamp, optional deactivated timestamp, optional
  inactive reason.
- **Read projection fields:** endpoint hash, created, updated, key version,
  active, optional inactive reason.
- **Inactive-reason values:** unsubscribed, transferred, dead, key revoked,
  session revoked.
- **Tombstone fields:** endpoint hash, operator id, deletion timestamp.
- **Operator-push routes (four, none of them an export):** VAPID public-key
  read; subscription create/replace; subscription unsubscribe; subscription
  metadata listing.
- **Audit event types:** subscribe, unsubscribe, subscription deactivated,
  dispatch, push disabled. All carry an event kind and correlation id.
- **Dispatch library:** `web-push@3.6.7`.

A change to any of these is a signal that `claims.ts` needs re-surveying.

## Drift ownership

This artifact has a scheduled owner: plan Unit 6
(`.github/workflows/privacy-claims-drift.yaml`, not yet implemented) is meant
to fetch the Gateway source at both the deployed pin and the latest release
on a schedule and diff privacy-relevant behavior against these claims. Until
that workflow lands, this artifact can silently drift from the Gateway after
the next behavior change — re-survey manually before relying on it as current
if `CLAIMS_SOURCE.surveyedTag` is more than a couple of Gateway releases
behind the live deployed pin.

Related maintenance debt: the vendored operator contract header
(`src/gateway/operator-contract/README.md`) is stale at `v0.78.0` against a
deployed `v0.93.1`. That refresh is tracked separately; this artifact's own
`CLAIMS_SOURCE.surveyedTag` (v0.113.2) is independent of it.
