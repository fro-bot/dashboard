/** Tests for the structured privacy claims used to build the public policy page. */
import type {Claim, ClaimCategory, ClaimValue, RetentionValue} from './claims.ts'

import {describe, expect, it} from 'vitest'
import {
  CLAIMS,
  formatClaimValue,
  formatRetention,
  getPublishedClaims,
  getUnverifiedClaims,
  isPublished,
  isUnverified,
  REQUIRED_CLAIM_CATEGORIES,
} from './claims.ts'

function isRetentionValue(value: ClaimValue): value is RetentionValue {
  return typeof value === 'object' && !Array.isArray(value) && 'unit' in value
}

// ---------------------------------------------------------------------------
// Happy path: every claim key resolves to a non-empty value
// ---------------------------------------------------------------------------

describe('published claims', () => {
  it('every published claim resolves to a non-empty value', () => {
    const published = getPublishedClaims()
    expect(published.length).toBeGreaterThan(0)
    for (const claim of published) {
      const text = formatClaimValue(claim)
      expect(text.length).toBeGreaterThan(0)
    }
  })

  it('getPublishedClaims returns only status:published entries', () => {
    for (const claim of getPublishedClaims()) {
      expect(claim.status).toBe('published')
    }
  })
})

// ---------------------------------------------------------------------------
// Edge case: retention values carry units and are marked configurable
// ---------------------------------------------------------------------------

describe('retention claims', () => {
  it('every retention-category claim is a unit-bearing, configurable value', () => {
    const retentionClaims = getPublishedClaims().filter(claim => claim.category === 'retention')
    expect(retentionClaims.length).toBeGreaterThanOrEqual(2)
    for (const claim of retentionClaims) {
      expect(isRetentionValue(claim.value)).toBe(true)
      if (isRetentionValue(claim.value)) {
        expect(claim.value.unit).toBe('days')
        expect(claim.value.configurable).toBe(true)
        expect(typeof claim.value.amount).toBe('number')
      }
    }
  })

  it('inactive and tombstone retention are separate, distinctly valued claims', () => {
    const inactive = CLAIMS.inactiveRetention
    const tombstone = CLAIMS.tombstoneRetention
    expect(inactive.status).toBe('published')
    expect(tombstone.status).toBe('published')
    if (inactive.status === 'published' && tombstone.status === 'published') {
      expect(isRetentionValue(inactive.value)).toBe(true)
      expect(isRetentionValue(tombstone.value)).toBe(true)
    }
    // Distinct values — this repo never states retention as one unconditional number.
    expect(inactive.value).not.toEqual(tombstone.value)
  })

  it('formatRetention never renders a bare number', () => {
    const rendered = formatRetention({amount: 30, unit: 'days', configurable: true})
    expect(rendered).toMatch(/days/)
    expect(rendered).toMatch(/configurable/)
  })
})

// ---------------------------------------------------------------------------
// Error path: an unverified claim cannot be rendered as an asserted fact
// ---------------------------------------------------------------------------

describe('unverified claims', () => {
  // Release gate. Omitting a real processing activity from a privacy notice is
  // itself a compliance failure, so "unverified" is a stop sign, not a third
  // state the page may ship with. Every item the survey could not confirm must
  // resolve to published-because-true or confirmed-absent-and-stated-as-such.
  it('no claim remains unverified — the page may not ship with an open item', () => {
    const unresolved = getUnverifiedClaims().map(claim => `${claim.category}: ${claim.reason}`)
    expect(unresolved).toEqual([])
  })

  it('an unverified claim is structurally incapable of carrying a renderable value', () => {
    // Fixture rather than a live entry: the invariant must hold for any future
    // unverified claim, and there are deliberately none in CLAIMS today.
    const fixture: Claim = {
      status: 'unverified',
      category: 'relay',
      reason: 'placeholder used to pin the structural invariant',
    }
    expect(isUnverified(fixture)).toBe(true)
    expect(isPublished(fixture)).toBe(false)
    expect('value' in fixture).toBe(false)
    // Only a PublishedClaim can reach the renderer.
    const renderable = [fixture].filter(isPublished)
    expect(renderable).toEqual([])
  })

  it('isPublished/isUnverified type guards partition CLAIMS with no overlap', () => {
    const allClaims: readonly Claim[] = Object.values(CLAIMS)
    const published = allClaims.filter(isPublished)
    const unverified = allClaims.filter(isUnverified)
    expect(published.length + unverified.length).toBe(allClaims.length)
  })

  it('the export surface is stated as an explicit negative, not omitted', () => {
    // There is no export endpoint. The page must say so rather than staying
    // silent, which would imply a capability that does not exist.
    expect(CLAIMS.exportSurface.status).toBe('published')
    expect(formatClaimValue(CLAIMS.exportSurface)).toMatch(/no separate export/i)
  })

  it('relay recipients are disclosed as a category, with no fixed vendor list claimed', () => {
    expect(CLAIMS.relayVendors.status).toBe('published')
    expect(formatClaimValue(CLAIMS.relayVendors)).toMatch(/selected by the browser/i)
  })

  it('relay metadata disclosure names the delivery headers a relay can see', () => {
    // Regression guard: an earlier draft said the Gateway "sets no TTL or
    // urgency header", which was true but misleading — the dispatch library
    // supplies defaults and they are sent on every request.
    const text = formatClaimValue(CLAIMS.relayProcessing)
    expect(text).toMatch(/time-to-live/i)
    expect(text).toMatch(/urgency/i)
    expect(text).not.toMatch(/sets no explicit/i)
  })
})

// ---------------------------------------------------------------------------
// Integration: the claim set covers every required disclosure category
// ---------------------------------------------------------------------------

describe('disclosure category coverage', () => {
  it('every required category has at least one claim', () => {
    const presentCategories = new Set<ClaimCategory>(Object.values(CLAIMS).map(claim => claim.category))
    for (const category of REQUIRED_CLAIM_CATEGORIES) {
      expect(presentCategories.has(category)).toBe(true)
    }
  })

  it('fails if a required category were silently dropped (regression guard)', () => {
    const presentCategories = new Set(Object.values(CLAIMS).map(claim => claim.category))
    const missing = REQUIRED_CLAIM_CATEGORIES.filter(category => !presentCategories.has(category))
    expect(missing).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Negative assertion: no endpoint, key, route path, storage path, or
// concrete account identifier appears anywhere in the serialized artifact.
// ---------------------------------------------------------------------------

describe('public-page safety', () => {
  const serialized = JSON.stringify(CLAIMS)

  it('contains no URL / endpoint value', () => {
    expect(serialized).not.toMatch(/https?:\/\//)
    expect(serialized).not.toMatch(/fcm\.googleapis|mozilla\.com|windows\.com/)
  })

  it('contains no internal HTTP route path', () => {
    // Any forward-slash-prefixed path segment, e.g. "/operator/push/...".
    expect(serialized).not.toMatch(/"\/[a-z0-9_-]+\/[a-z0-9_/-]*"/i)
    expect(serialized).not.toMatch(/\/operator\//)
  })

  it('contains no storage path or filesystem reference', () => {
    expect(serialized).not.toMatch(/\.(pem|key|db|sqlite)\b/i)
    expect(serialized).not.toMatch(/\/var\/|\/tmp\/|localStorage|indexedDB/)
  })

  it('contains no concrete key material or key-material-shaped token', () => {
    // VAPID/P-256 keys are base64url and long; guard against anything
    // resembling a pasted key rather than a category description.
    expect(serialized).not.toMatch(/[A-Za-z0-9_-]{80,}/)
  })

  it('contains no concrete account identifier (numeric GitHub user id)', () => {
    expect(serialized).not.toMatch(/"operatorId"\s*:\s*\d+/)
    expect(serialized).not.toMatch(/\boperatorId\b/)
  })

  it('mentions data categories in prose without embedding real endpoint/key instances', () => {
    // Sanity check the artifact still describes the right categories in
    // words (this is not a leak — it's the whole point of the page).
    expect(serialized).toMatch(/endpoint/i)
    expect(serialized).toMatch(/P-256/i)
  })
})
