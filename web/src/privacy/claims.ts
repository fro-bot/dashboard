/**
 * Structured source for the public `/privacy` page copy, describing the
 * Gateway-owned push surface.
 *
 * Compiled into a public, unauthenticated page: every value must be a data
 * category, never an instance. No endpoints, key material, route or storage
 * paths, or account identifiers. `claims.test.ts` enforces this.
 *
 * `UnverifiedClaim` carries no `value`, so an unresolved item cannot reach the
 * page as an asserted fact.
 */

/** Disclosure categories the privacy page is required to cover. */
export type ClaimCategory =
  | 'stored-fields'
  | 'read-surface'
  | 'retention'
  | 'deletion'
  | 'deactivation'
  | 'audit'
  | 'vapid-rotation'
  | 'relay'
  | 'payload'
  | 'export-surface'

/** Every required disclosure category — the coverage test iterates this. */
export const REQUIRED_CLAIM_CATEGORIES = [
  'stored-fields',
  'read-surface',
  'retention',
  'deletion',
  'deactivation',
  'audit',
  'vapid-rotation',
  'relay',
  'payload',
  'export-surface',
] as const satisfies readonly ClaimCategory[]

/** A retention duration, always unit-bearing and always marked configurable. */
export interface RetentionValue {
  readonly amount: number
  readonly unit: 'days'
  readonly configurable: true
}

/** A value a published claim may carry: prose, a category list, or a retention duration. */
export type ClaimValue = string | readonly string[] | RetentionValue

/** A claim confirmed by the survey and safe to render as fact. */
export interface PublishedClaim {
  readonly status: 'published'
  readonly category: ClaimCategory
  readonly value: ClaimValue
  readonly sourceNote: string
}

/**
 * A claim the survey could not confirm. Deliberately carries no `value` —
 * there is nothing here for a renderer to print as an asserted fact. Only
 * `reason` (why it's unresolved) is available.
 */
export interface UnverifiedClaim {
  readonly status: 'unverified'
  readonly category: ClaimCategory
  readonly reason: string
}

export type Claim = PublishedClaim | UnverifiedClaim

/** Type guard narrowing a `Claim` to a `PublishedClaim`. */
export function isPublished(claim: Claim): claim is PublishedClaim {
  return claim.status === 'published'
}

/** Type guard narrowing a `Claim` to an `UnverifiedClaim`. */
export function isUnverified(claim: Claim): claim is UnverifiedClaim {
  return claim.status === 'unverified'
}

/**
 * The pinned claim set. Keys are stable identifiers the future policy page
 * references; values are either published (renderable) or unverified
 * (structurally unrenderable as fact).
 */
export const CLAIMS = {
  storedSubscriptionFields: {
    status: 'published',
    category: 'stored-fields',
    value: [
      'a one-way hash of the browser push endpoint',
      'the browser push endpoint URL',
      "the browser's generated P-256 public key",
      "the browser's generated authentication secret",
      "the operator's GitHub account identifier",
      'an active/inactive flag',
      'the signing-key version in effect when the subscription was created',
      'an ownership-generation counter, used to detect a transferred session',
      'created and last-updated timestamps',
      'an optional deactivation timestamp',
      'an optional coarse deactivation reason',
    ],
    sourceNote: 'Gateway subscription record shape, per the fro-bot/agent survey.',
  },
  readSurfaceProjection: {
    status: 'published',
    category: 'read-surface',
    value: [
      'a one-way hash of the endpoint',
      'created and last-updated timestamps',
      'the signing-key version',
      'the active/inactive flag',
      'an optional coarse inactive reason',
    ],
    sourceNote:
      'What an operator can read back about their own subscription. The endpoint URL, the P-256 public key, and the authentication secret are never returned by any read surface.',
  },
  deactivationReasons: {
    status: 'published',
    category: 'deactivation',
    value: [
      'the operator unsubscribed',
      'ownership of the browser session was transferred',
      'the push relay reported the endpoint as dead',
      'the signing key was revoked',
      'the operator session was revoked',
    ],
    sourceNote: 'The Gateway deactivation-reason set, per the fro-bot/agent survey.',
  },
  inactiveRetention: {
    status: 'published',
    category: 'retention',
    value: {amount: 30, unit: 'days', configurable: true} satisfies RetentionValue,
    sourceNote:
      'Default retention for a deactivated (but not yet tombstoned) subscription record. Configurable — not an unconditional guarantee.',
  },
  tombstoneRetention: {
    status: 'published',
    category: 'retention',
    value: {amount: 90, unit: 'days', configurable: true} satisfies RetentionValue,
    sourceNote:
      'Default retention for a deletion tombstone, tracked separately from inactive-record retention. Configurable — not an unconditional guarantee.',
  },
  deletionBehavior: {
    status: 'published',
    category: 'deletion',
    value:
      "Deletion writes a secret-free tombstone recording the endpoint hash, the operator's account identifier, and the deletion timestamp, then physically removes the subscription record. Read paths exclude tombstoned hashes. A later authenticated re-subscribe clears the tombstone.",
    sourceNote: 'Gateway deletion and tombstone behavior, per the fro-bot/agent survey.',
  },
  auditEvents: {
    status: 'published',
    category: 'audit',
    value: [
      "subscribe (records the operator's account identifier)",
      "unsubscribe (records the operator's account identifier)",
      "deactivation (records the operator's account identifier and a coarse reason)",
      'dispatch (records a trigger label and delivered/dead/failed counts)',
      'push disabled (records a coarse reason)',
    ],
    sourceNote:
      'Every audit record also carries an event kind and a correlation identifier. No endpoint, key material, payload, or repository/run content is ever recorded.',
  },
  vapidRotation: {
    status: 'published',
    category: 'vapid-rotation',
    value:
      'Subscriptions registered under the current or immediately previous signing key remain deliverable. Subscriptions on an older key are skipped as stale until the browser re-registers. Rotating the signing key does not deactivate or delete any subscription record.',
    sourceNote: 'Gateway VAPID rotation semantics, per the fro-bot/agent survey.',
  },
  relayProcessing: {
    status: 'published',
    category: 'relay',
    value:
      "The browser chooses which push relay handles delivery, by the endpoint it issues; the Gateway sends to that endpoint and does not restrict which providers may be used. Each delivery request carries a time-to-live of four weeks and normal urgency, and no topic. A relay can observe the endpoint identity, request timing, the size of the encrypted payload, the time-to-live and urgency values, authentication information identifying this service as the sender, delivery status, and the sending server's network metadata. It cannot read the encrypted notification content.",
    sourceNote:
      'Gateway push-dispatch behavior toward the browser-chosen relay. The time-to-live and urgency values are supplied as defaults by the dispatch library rather than set explicitly by the Gateway, but they are sent on every request and are visible to the relay either way — stating only that the Gateway sets no headers would be true and misleading.',
  },
  payloadContents: {
    status: 'published',
    category: 'payload',
    value:
      'Notification payloads use fixed, neutral copy plus a small set of allowlisted failure labels. They never include repository names, prompts, run identifiers, run output, endpoints, signing keys, tokens, cookies, or session data.',
    sourceNote: 'Gateway payload construction, per the fro-bot/agent survey.',
  },
  exportSurface: {
    status: 'published',
    category: 'export-surface',
    value:
      'Subscription metadata can be read back through the operator interface. There is no separate export or download surface — the metadata listing is the access path, and it returns the same fields described above, never the endpoint URL or the browser keys.',
    sourceNote:
      'Resolved by a full enumeration of the Gateway operator-push routes at the pinned tag: four routes exist, none of which is an export, download, or data-subject-access endpoint. No export surface exists elsewhere in the Gateway either. Recorded as an explicit negative so the page states the limit rather than implying a capability.',
  },
  relayVendors: {
    status: 'published',
    category: 'relay',
    value:
      "Delivery goes to the push service selected by the browser or operating system. Depending on platform this may be a service operated by Google, Mozilla, Apple, Microsoft's browser platform, or another compatible browser push provider. This service does not maintain a fixed list of providers, because the choice belongs to the browser rather than to this service.",
    sourceNote:
      'Resolved at the pinned tag: the subscribe and dispatch paths contain no vendor allowlist, fixed-origin comparison, or vendor-specific branch. Endpoint validation is a transport and network-safety filter (HTTPS required, loopback and private ranges rejected), not a vendor restriction. Disclosed as a recipient category because the concrete vendor is determined per subscription by the browser.',
  },
} as const satisfies Record<string, Claim>

export type ClaimKey = keyof typeof CLAIMS

function allClaims(): readonly Claim[] {
  return Object.values(CLAIMS)
}

/** All published claims, safe to render as fact. */
export function getPublishedClaims(): readonly PublishedClaim[] {
  return allClaims().filter(isPublished)
}

/** All unverified claims — never render `.reason` as an asserted fact about Gateway behavior. */
export function getUnverifiedClaims(): readonly UnverifiedClaim[] {
  return allClaims().filter(isUnverified)
}

/** Render a retention duration with its unit, never as a bare number. */
export function formatRetention(retention: RetentionValue): string {
  return `${retention.amount} ${retention.unit}${retention.configurable ? ' (configurable)' : ''}`
}

function isRetentionValue(value: ClaimValue): value is RetentionValue {
  return typeof value === 'object' && !Array.isArray(value) && 'unit' in value
}

/** Render any published claim value as display text. */
export function formatClaimValue(claim: PublishedClaim): string {
  const {value} = claim
  if (typeof value === 'string') {
    return value
  }
  if (isRetentionValue(value)) {
    return formatRetention(value)
  }
  return value.join('; ')
}
