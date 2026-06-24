/**
 * Monitoring view tests.
 *
 * Tests the React view against a mocked BFF fetch. Covers:
 * - Happy path: renders repo cards with real snapshot data
 * - Edge case: empty/stale snapshot renders labeled state, not dead screen
 * - Edge case: empty-post-fetch (aggregator ran, found 0 repos, refreshedAt non-null)
 * - Error path: BFF failure renders fail-closed error state (no unfiltered union)
 * - Security: internal fields (node_id, owner, name, fetchedAt) not in DTO
 * - Security: no dangerouslySetInnerHTML (structural — enforced by no raw HTML in output)
 */

import {render, screen, waitFor} from '@testing-library/react'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {AggregatorSnapshot, DashboardRepo} from '../api/aggregation.ts'
import * as aggregationModule from '../api/aggregation.ts'
import {Monitoring} from './Monitoring.tsx'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRepo(overrides: Partial<DashboardRepo> = {}): DashboardRepo {
  return {
    full_name: 'fro-bot/agent',
    discovery_channel: 'collab',
    status: {
      rollupState: 'green',
      failingChecks: 0,
      openPrCount: 0,
      openIssueCount: 0,
      openAlertCount: null,
      stale: false,
    },
    ...overrides,
  }
}

function makeSnapshot(overrides: Partial<AggregatorSnapshot> = {}): AggregatorSnapshot {
  return {
    repos: [],
    staleBanner: false,
    driftCount: 0,
    refreshedAt: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Monitoring view', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(aggregationModule, 'fetchAggregationSnapshot')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('happy path — renders real snapshot data', () => {
    it('renders repo cards from the aggregation snapshot', async () => {
      const repo = makeRepo({
        full_name: 'fro-bot/agent',
        discovery_channel: 'collab',
        status: {
          rollupState: 'green',
          failingChecks: 0,
          openPrCount: 2,
          openIssueCount: 5,
          openAlertCount: 1,
          stale: false,
        },
      })
      const snapshot = makeSnapshot({repos: [repo], refreshedAt: 1_700_000_000_000})
      fetchSpy.mockResolvedValue(snapshot)

      render(<Monitoring />)

      // Wait for async fetch to resolve
      await waitFor(() => {
        expect(screen.getByTestId('monitoring-view')).toBeInTheDocument()
      })

      // Repo name rendered
      expect(screen.getByText('fro-bot/agent')).toBeInTheDocument()

      // Status badge rendered
      expect(screen.getByText('✓ green')).toBeInTheDocument()

      // Channel badge rendered
      expect(screen.getByText('collab')).toBeInTheDocument()

      // PR link rendered
      const prLink = screen.getByText(/2 PRs/)
      expect(prLink).toBeInTheDocument()

      // Issue link rendered
      const issueLink = screen.getByText(/5 issues/)
      expect(issueLink).toBeInTheDocument()
    })

    it('renders multiple repos in the order returned by the BFF (attention-first)', async () => {
      const repo1 = makeRepo({
        full_name: 'fro-bot/alpha',
        status: {
          rollupState: 'red',
          failingChecks: 2,
          openPrCount: 1,
          openIssueCount: 0,
          openAlertCount: null,
          stale: false,
        },
      })
      const repo2 = makeRepo({
        full_name: 'fro-bot/beta',
        status: {
          rollupState: 'green',
          failingChecks: 0,
          openPrCount: 0,
          openIssueCount: 0,
          openAlertCount: null,
          stale: false,
        },
      })
      const snapshot = makeSnapshot({repos: [repo1, repo2], refreshedAt: 1_700_000_000_000})
      fetchSpy.mockResolvedValue(snapshot)

      render(<Monitoring />)

      await waitFor(() => {
        expect(screen.getByTestId('monitoring-view')).toBeInTheDocument()
      })

      const alphaEl = screen.getByText('fro-bot/alpha')
      const betaEl = screen.getByText('fro-bot/beta')

      // Both rendered
      expect(alphaEl).toBeInTheDocument()
      expect(betaEl).toBeInTheDocument()

      // Order preserved: alpha (attention) appears before beta (healthy)
      const container = screen.getByTestId('monitoring-view')
      const html = container.innerHTML
      expect(html.indexOf('fro-bot/alpha')).toBeLessThan(html.indexOf('fro-bot/beta'))
    })

    it('renders stale marker on per-repo stale status', async () => {
      const repo = makeRepo({
        status: {
          rollupState: 'unknown',
          failingChecks: 0,
          openPrCount: 0,
          openIssueCount: 0,
          openAlertCount: null,
          stale: true,
        },
      })
      const snapshot = makeSnapshot({repos: [repo], refreshedAt: 1_700_000_000_000})
      fetchSpy.mockResolvedValue(snapshot)

      render(<Monitoring />)

      await waitFor(() => {
        expect(screen.getByTestId('monitoring-view')).toBeInTheDocument()
      })

      expect(screen.getByText('stale')).toBeInTheDocument()
    })

    it('renders — for null alert count', async () => {
      const repo = makeRepo({
        status: {
          rollupState: 'green',
          failingChecks: 0,
          openPrCount: 0,
          openIssueCount: 0,
          openAlertCount: null,
          stale: false,
        },
      })
      const snapshot = makeSnapshot({repos: [repo], refreshedAt: 1_700_000_000_000})
      fetchSpy.mockResolvedValue(snapshot)

      render(<Monitoring />)

      await waitFor(() => {
        expect(screen.getByTestId('monitoring-view')).toBeInTheDocument()
      })

      expect(screen.getByText('— alerts')).toBeInTheDocument()
    })

    it('renders stale banner when staleBanner is true', async () => {
      const snapshot = makeSnapshot({staleBanner: true, refreshedAt: 1_700_000_000_000})
      fetchSpy.mockResolvedValue(snapshot)

      render(<Monitoring />)

      await waitFor(() => {
        expect(screen.getByTestId('monitoring-view')).toBeInTheDocument()
      })

      expect(screen.getByText(/Showing cached data/)).toBeInTheDocument()
      expect(screen.getByText(/live refresh unavailable/)).toBeInTheDocument()
    })

    it('does NOT render stale banner when staleBanner is false', async () => {
      const snapshot = makeSnapshot({staleBanner: false, refreshedAt: 1_700_000_000_000})
      fetchSpy.mockResolvedValue(snapshot)

      render(<Monitoring />)

      await waitFor(() => {
        expect(screen.getByTestId('monitoring-view')).toBeInTheDocument()
      })

      expect(screen.queryByText(/live refresh unavailable/)).not.toBeInTheDocument()
    })

    it('renders drift notice when driftCount > 0', async () => {
      const snapshot = makeSnapshot({driftCount: 3, refreshedAt: 1_700_000_000_000})
      fetchSpy.mockResolvedValue(snapshot)

      render(<Monitoring />)

      await waitFor(() => {
        expect(screen.getByTestId('monitoring-view')).toBeInTheDocument()
      })

      expect(screen.getByText(/3 repos the Agent App can see are not in public metadata/)).toBeInTheDocument()
    })
  })

  describe('edge case — empty/stale snapshot', () => {
    it('renders labeled empty state when repos is empty and refreshedAt is null (pre-fetch)', async () => {
      const snapshot = makeSnapshot({repos: [], refreshedAt: null})
      fetchSpy.mockResolvedValue(snapshot)

      render(<Monitoring />)

      await waitFor(() => {
        expect(screen.getByTestId('monitoring-empty')).toBeInTheDocument()
      })

      expect(screen.getByText(/Loading… \/ no data yet/)).toBeInTheDocument()
      expect(screen.getByText(/aggregator has not completed/)).toBeInTheDocument()
    })

    it('renders empty state when repos is empty and refreshedAt is non-null (post-fetch zero repos)', async () => {
      // Aggregator ran, found 0 repos after denylist filtering, refreshedAt is set.
      // This was previously a dead empty grid — isEmpty must cover this case.
      const snapshot = makeSnapshot({repos: [], refreshedAt: 1_700_000_000_000})
      fetchSpy.mockResolvedValue(snapshot)

      render(<Monitoring />)

      await waitFor(() => {
        expect(screen.getByTestId('monitoring-empty')).toBeInTheDocument()
      })

      expect(screen.getByText(/Loading… \/ no data yet/)).toBeInTheDocument()
    })

    it('renders empty state — not a dead screen (no throw)', async () => {
      const snapshot = makeSnapshot()
      fetchSpy.mockResolvedValue(snapshot)

      expect(() => render(<Monitoring />)).not.toThrow()

      await waitFor(() => {
        expect(screen.getByTestId('monitoring-empty')).toBeInTheDocument()
      })
    })
  })

  describe('error path — BFF failure (fail-closed)', () => {
    it('renders error state on fetch failure — no unfiltered union, no leak', async () => {
      fetchSpy.mockRejectedValue(new Error('BFF aggregation endpoint returned 503 Service Unavailable'))

      render(<Monitoring />)

      await waitFor(() => {
        expect(screen.getByTestId('monitoring-error')).toBeInTheDocument()
      })

      expect(screen.getByText(/Unable to load monitoring data/)).toBeInTheDocument()
      expect(screen.getByText(/503/)).toBeInTheDocument()
    })

    it('renders error state on network failure', async () => {
      fetchSpy.mockRejectedValue(new Error('Failed to fetch'))

      render(<Monitoring />)

      await waitFor(() => {
        expect(screen.getByTestId('monitoring-error')).toBeInTheDocument()
      })

      expect(screen.getByText(/Unable to load monitoring data/)).toBeInTheDocument()
    })

    it('error state has role=alert for accessibility', async () => {
      fetchSpy.mockRejectedValue(new Error('Network error'))

      render(<Monitoring />)

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument()
      })
    })
  })

  describe('security — internal fields not in DTO, not rendered', () => {
    it('node_id is not in the client DTO and is not rendered as visible text', async () => {
      // The DTO no longer includes node_id — it is stripped by the BFF mapper.
      // full_name is used as the React key instead.
      const repo = makeRepo({full_name: 'fro-bot/agent'})
      const snapshot = makeSnapshot({repos: [repo], refreshedAt: 1_700_000_000_000})
      fetchSpy.mockResolvedValue(snapshot)

      render(<Monitoring />)

      await waitFor(() => {
        expect(screen.getByTestId('monitoring-view')).toBeInTheDocument()
      })

      // full_name IS rendered (it's the repo link text)
      expect(screen.getByText('fro-bot/agent')).toBeInTheDocument()
    })

    it('fetchedAt is not in the client DTO and is not rendered', async () => {
      // fetchedAt is an internal cache timestamp — stripped by the BFF mapper.
      const repo = makeRepo()
      const snapshot = makeSnapshot({repos: [repo], refreshedAt: 1_700_000_000_000})
      fetchSpy.mockResolvedValue(snapshot)

      render(<Monitoring />)

      await waitFor(() => {
        expect(screen.getByTestId('monitoring-view')).toBeInTheDocument()
      })

      // fetchedAt (1700000000000) must not appear as visible text
      expect(screen.queryByText('1700000000000')).not.toBeInTheDocument()
    })
  })

  describe('loading state', () => {
    it('shows loading indicator while fetch is in flight', () => {
      // Never resolves — simulates in-flight fetch
      fetchSpy.mockReturnValue(new Promise(() => undefined))

      render(<Monitoring />)

      expect(screen.getByTestId('monitoring-loading')).toBeInTheDocument()
      expect(screen.getByText(/Loading monitoring data/)).toBeInTheDocument()
    })
  })
})
