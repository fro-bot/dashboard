import {render, screen, waitFor, fireEvent} from '@testing-library/react'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {AggregationResult, AggregatorSnapshot, DashboardRepo} from '../api/aggregation.ts'
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
      rollupState: 'red', // failing by default to render prominently
      failingChecks: 1,
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

/** Fresh result — no cache headers. */
function makeFreshResult(snapshotOverrides: Partial<AggregatorSnapshot> = {}): AggregationResult {
  return {
    data: makeSnapshot(snapshotOverrides),
    servedFromCache: false,
    cachedAt: null,
  }
}

/** Stale-from-cache result — served by the service worker offline cache. */
function makeCachedResult(
  snapshotOverrides: Partial<AggregatorSnapshot> = {},
  cachedAt: number | null = Date.now() - 2 * 60 * 1000,
): AggregationResult {
  return {
    data: makeSnapshot(snapshotOverrides),
    servedFromCache: true,
    cachedAt,
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
          rollupState: 'red',
          failingChecks: 1,
          openPrCount: 2,
          openIssueCount: 5,
          openAlertCount: 1,
          stale: false,
        },
      })
      fetchSpy.mockResolvedValue(makeFreshResult({repos: [repo], refreshedAt: 1_700_000_000_000}))

      render(<Monitoring />)

      // Wait for async fetch to resolve
      await waitFor(() => {
        expect(screen.getByTestId('monitoring-view')).toBeInTheDocument()
      })

      // Repo name rendered
      expect(screen.getByText('fro-bot/agent')).toBeInTheDocument()

      // Status badge rendered
      expect(screen.getByText('✗ red')).toBeInTheDocument()

      // Channel badge rendered
      expect(screen.getByText('collab')).toBeInTheDocument()

      // PR link rendered
      const prLink = screen.getByText(/2 PRs/)
      expect(prLink).toBeInTheDocument()

      // Issue link rendered
      const issueLink = screen.getByText(/5 issues/)
      expect(issueLink).toBeInTheDocument()

      // Alert display rendered
      expect(screen.getByText(/1 alert/)).toBeInTheDocument()
    })
    
    it('collapses healthy repos by default and expands on click', async () => {
      const healthyRepo = makeRepo({
        full_name: 'fro-bot/healthy-repo',
        status: { rollupState: 'green', failingChecks: 0, openPrCount: 0, openIssueCount: 0, openAlertCount: 0, stale: false }
      })
      fetchSpy.mockResolvedValue(makeFreshResult({repos: [healthyRepo], refreshedAt: 1_700_000_000_000}))

      render(<Monitoring />)

      await waitFor(() => {
        expect(screen.getByTestId('monitoring-view')).toBeInTheDocument()
      })

      // Healthy repo is collapsed
      expect(screen.queryByText('fro-bot/healthy-repo')).not.toBeInTheDocument()
      
      // Expand healthy repos
      const expandBtn = screen.getByRole('button', { name: /1 healthy repo/i })
      fireEvent.click(expandBtn)
      
      // Now it's visible
      expect(screen.getByText('fro-bot/healthy-repo')).toBeInTheDocument()
    })
  })

  describe('fresh response — no stale banner', () => {
    it('does NOT render the stale-from-cache banner when servedFromCache is false', async () => {
      fetchSpy.mockResolvedValue(makeFreshResult({repos: [makeRepo()], refreshedAt: 1_700_000_000_000}))

      render(<Monitoring />)

      await waitFor(() => {
        expect(screen.getByTestId('monitoring-view')).toBeInTheDocument()
      })

      expect(screen.queryByTestId('stale-cache-banner')).not.toBeInTheDocument()
    })
  })

  describe('stale-from-cache — banner with age', () => {
    it('renders the stale-cache banner when servedFromCache is true', async () => {
      const cachedAt = Date.now() - 2 * 60 * 1000 // 2 minutes ago
      fetchSpy.mockResolvedValue(
        makeCachedResult({repos: [makeRepo()], refreshedAt: 1_700_000_000_000}, cachedAt),
      )

      render(<Monitoring />)

      await waitFor(() => {
        expect(screen.getByTestId('stale-cache-banner')).toBeInTheDocument()
      })

      // Banner text includes age and connection-lost message
      expect(screen.getByTestId('stale-cache-banner')).toHaveTextContent(/connection lost/i)
    })

    it('shows a human-readable age in the stale banner', async () => {
      const cachedAt = Date.now() - 5 * 60 * 1000 // 5 minutes ago
      fetchSpy.mockResolvedValue(makeCachedResult({repos: [makeRepo()]}, cachedAt))

      render(<Monitoring />)

      await waitFor(() => {
        expect(screen.getByTestId('stale-cache-banner')).toBeInTheDocument()
      })

      // Should show something like "5 minutes ago"
      expect(screen.getByTestId('stale-cache-banner')).toHaveTextContent(/minute/)
    })

    it('still renders the data below the stale banner', async () => {
      const repo = makeRepo({full_name: 'fro-bot/cached-repo'})
      fetchSpy.mockResolvedValue(makeCachedResult({repos: [repo], refreshedAt: 1_700_000_000_000}))

      render(<Monitoring />)

      await waitFor(() => {
        expect(screen.getByTestId('stale-cache-banner')).toBeInTheDocument()
      })

      // Data is still rendered
      expect(screen.getByTestId('monitoring-view')).toBeInTheDocument()
      expect(screen.getByText('fro-bot/cached-repo')).toBeInTheDocument()
    })

    it('degrades gracefully when cachedAt is null — shows generic offline/stale message', async () => {
      fetchSpy.mockResolvedValue(makeCachedResult({repos: [makeRepo()]}, null))

      render(<Monitoring />)

      await waitFor(() => {
        expect(screen.getByTestId('stale-cache-banner')).toBeInTheDocument()
      })

      // No crash; banner still renders with a fallback message
      expect(screen.getByTestId('stale-cache-banner')).toHaveTextContent(/offline|stale|connection/i)
    })
  })

  describe('offline-no-cache — explicit offline state', () => {
    it('renders the offline state when fetch fails and there is no cached snapshot', async () => {
      fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'))

      render(<Monitoring />)

      await waitFor(() => {
        expect(screen.getByTestId('monitoring-offline')).toBeInTheDocument()
      })

      expect(screen.getByText(/offline/i)).toBeInTheDocument()
    })

    it('offline state has a retry button', async () => {
      fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'))

      render(<Monitoring />)

      await waitFor(() => {
        expect(screen.getByTestId('monitoring-offline')).toBeInTheDocument()
      })

      expect(screen.getByRole('button', {name: /retry/i})).toBeInTheDocument()
    })

    it('retry button re-triggers the fetch', async () => {
      fetchSpy.mockRejectedValueOnce(new TypeError('Failed to fetch'))
      fetchSpy.mockResolvedValueOnce(makeFreshResult({repos: [makeRepo()], refreshedAt: 1_700_000_000_000}))

      render(<Monitoring />)

      await waitFor(() => {
        expect(screen.getByTestId('monitoring-offline')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByRole('button', {name: /retry/i}))

      await waitFor(() => {
        expect(screen.getByTestId('monitoring-view')).toBeInTheDocument()
      })

      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })

    it('offline state is DISTINCT from the empty state (no repos)', async () => {
      // Empty state: fetch succeeds but returns zero repos
      fetchSpy.mockResolvedValue(makeFreshResult({repos: []}))

      render(<Monitoring />)

      await waitFor(() => {
        expect(screen.getByTestId('monitoring-empty')).toBeInTheDocument()
      })

      // Offline state must NOT be shown
      expect(screen.queryByTestId('monitoring-offline')).not.toBeInTheDocument()
    })

    it('offline state is DISTINCT from the loading state', () => {
      fetchSpy.mockImplementation(() => new Promise(() => {}))

      render(<Monitoring />)

      expect(screen.getByTestId('monitoring-loading')).toBeInTheDocument()
      expect(screen.queryByTestId('monitoring-offline')).not.toBeInTheDocument()
    })
  })

  describe('edge cases', () => {
    it('renders labeled empty state when repos is empty and refreshedAt is null (pre-fetch)', async () => {
      fetchSpy.mockResolvedValue(makeFreshResult({repos: [], refreshedAt: null}))

      render(<Monitoring />)

      await waitFor(() => {
        expect(screen.getByTestId('monitoring-empty')).toBeInTheDocument()
      })
      expect(screen.getByText(/no data yet/i)).toBeInTheDocument()
    })

    it('renders empty state when repos is empty and refreshedAt is non-null (post-fetch zero repos)', async () => {
      fetchSpy.mockResolvedValue(makeFreshResult({repos: [], refreshedAt: 1_700_000_000_000}))

      render(<Monitoring />)

      await waitFor(() => {
        expect(screen.getByTestId('monitoring-empty')).toBeInTheDocument()
      })
      expect(screen.getByText(/no data yet/i)).toBeInTheDocument()
    })

    it('renders stale marker on per-repo stale status', async () => {
      const repo = makeRepo({
        status: {
          rollupState: 'green',
          failingChecks: 0,
          openPrCount: 0,
          openIssueCount: 0,
          openAlertCount: 0,
          stale: true,
        },
      })
      fetchSpy.mockResolvedValue(makeFreshResult({repos: [repo], refreshedAt: 1_700_000_000_000}))

      render(<Monitoring />)

      await waitFor(() => {
        expect(screen.getByTestId('monitoring-view')).toBeInTheDocument()
      })
      // 1 in summary strip
      expect(screen.getByText('1 stale')).toBeInTheDocument()
      // 1 in repo card (stale badge)
      expect(screen.getByText('stale', { selector: 'span' })).toBeInTheDocument()
    })

    it('renders server-side stale banner when staleBanner is true', async () => {
      fetchSpy.mockResolvedValue(makeFreshResult({staleBanner: true}))

      render(<Monitoring />)

      await waitFor(() => {
        expect(screen.getByTestId('monitoring-view')).toBeInTheDocument()
      })
      expect(screen.getByText(/Showing cached data/)).toBeInTheDocument()
    })

    it('does NOT render server-side stale banner when staleBanner is false', async () => {
      fetchSpy.mockResolvedValue(makeFreshResult({staleBanner: false}))

      render(<Monitoring />)

      await waitFor(() => {
        expect(screen.getByTestId('monitoring-view')).toBeInTheDocument()
      })
      expect(screen.queryByText(/Showing cached data/)).not.toBeInTheDocument()
    })

    it('renders drift notice when driftCount > 0', async () => {
      fetchSpy.mockResolvedValue(makeFreshResult({driftCount: 42}))

      render(<Monitoring />)

      await waitFor(() => {
        expect(screen.getByTestId('monitoring-view')).toBeInTheDocument()
      })
      expect(screen.getByText(/42 repos.*not in public metadata/)).toBeInTheDocument()
    })
  })

  describe('error handling', () => {
    it('renders offline state on fetch failure — no unfiltered union, no leak', async () => {
      fetchSpy.mockRejectedValue(new Error('Network offline'))

      render(<Monitoring />)

      await waitFor(() => {
        expect(screen.getByTestId('monitoring-offline')).toBeInTheDocument()
      })

      // Fails closed — does not render the view or any fake repos
      expect(screen.queryByTestId('monitoring-view')).not.toBeInTheDocument()
      expect(screen.queryByTestId('monitoring-error')).not.toBeInTheDocument()
    })

    it('renders offline state on network failure', async () => {
      fetchSpy.mockRejectedValue(new Error('Failed to fetch'))

      render(<Monitoring />)

      await waitFor(() => {
        expect(screen.getByTestId('monitoring-offline')).toBeInTheDocument()
      })
    })

    it('renders empty state — not a dead screen (no throw)', async () => {
      fetchSpy.mockResolvedValue(makeFreshResult({repos: []}))

      render(<Monitoring />)

      await waitFor(() => {
        expect(screen.getByTestId('monitoring-empty')).toBeInTheDocument()
      })
    })

    it('offline state has role=alert for accessibility', async () => {
      fetchSpy.mockRejectedValue(new Error('boom'))

      render(<Monitoring />)

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument()
      })
    })
  })

  describe('security — internal fields not in DTO, not rendered', () => {
    it('node_id is not in the client DTO and is not rendered as visible text', async () => {
      // Create a repo object mimicking what the real BFF emits.
      // TypeScript enforces that node_id is not in DashboardRepo, but we
      // simulate a malicious API response that accidentally includes it.
      const leakedRepo = {
        ...makeRepo(),
        node_id: 'R_kgDOKzABCD',
        owner: 'fro-bot',
        name: 'agent',
      } as unknown as DashboardRepo

      fetchSpy.mockResolvedValue(makeFreshResult({repos: [leakedRepo], refreshedAt: 1_700_000_000_000}))

      render(<Monitoring />)

      await waitFor(() => {
        expect(screen.getByTestId('monitoring-view')).toBeInTheDocument()
      })

      // The internal IDs must not be rendered anywhere
      expect(screen.queryByText('R_kgDOKzABCD')).not.toBeInTheDocument()

      // full_name IS rendered (it's the repo link text)
      expect(screen.getByText('fro-bot/agent')).toBeInTheDocument()
    })

    it('fetchedAt is not in the client DTO and is not rendered', async () => {
      const leakedRepo = {
        ...makeRepo(),
        fetchedAt: 1_699_000_000_000,
      } as unknown as DashboardRepo

      fetchSpy.mockResolvedValue(makeFreshResult({repos: [leakedRepo], refreshedAt: 1_700_000_000_000}))

      render(<Monitoring />)

      await waitFor(() => {
        expect(screen.getByTestId('monitoring-view')).toBeInTheDocument()
      })

      expect(screen.queryByText('1699000000000')).not.toBeInTheDocument()
    })
  })

  describe('loading state', () => {
    it('shows loading indicator while fetch is in flight', () => {
      // fetchSpy is mocked but unresolved initially
      fetchSpy.mockImplementation(() => new Promise(() => {}))

      render(<Monitoring />)

      expect(screen.getByTestId('monitoring-loading')).toBeInTheDocument()
      expect(screen.getByText('Loading monitoring data…')).toBeInTheDocument()
      expect(screen.queryByTestId('monitoring-view')).not.toBeInTheDocument()
    })
  })
})
