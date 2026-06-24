import {render, screen, waitFor, fireEvent} from '@testing-library/react'
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
      fetchSpy.mockResolvedValue(makeSnapshot({repos: [healthyRepo], refreshedAt: 1_700_000_000_000}))

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

  describe('edge cases', () => {
    it('renders labeled empty state when repos is empty and refreshedAt is null (pre-fetch)', async () => {
      fetchSpy.mockResolvedValue(makeSnapshot({repos: [], refreshedAt: null}))

      render(<Monitoring />)

      await waitFor(() => {
        expect(screen.getByTestId('monitoring-empty')).toBeInTheDocument()
      })
      expect(screen.getByText(/no data yet/i)).toBeInTheDocument()
    })

    it('renders empty state when repos is empty and refreshedAt is non-null (post-fetch zero repos)', async () => {
      fetchSpy.mockResolvedValue(makeSnapshot({repos: [], refreshedAt: 1_700_000_000_000}))

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
      fetchSpy.mockResolvedValue(makeSnapshot({repos: [repo], refreshedAt: 1_700_000_000_000}))

      render(<Monitoring />)

      await waitFor(() => {
        expect(screen.getByTestId('monitoring-view')).toBeInTheDocument()
      })
      // 1 in summary strip
      expect(screen.getByText('1 stale')).toBeInTheDocument()
      // 1 in repo card (stale badge)
      expect(screen.getByText('stale', { selector: 'span' })).toBeInTheDocument()
    })

    it('renders stale banner when staleBanner is true', async () => {
      fetchSpy.mockResolvedValue(makeSnapshot({staleBanner: true}))

      render(<Monitoring />)

      await waitFor(() => {
        expect(screen.getByTestId('monitoring-view')).toBeInTheDocument()
      })
      expect(screen.getByText(/Showing cached data/)).toBeInTheDocument()
    })

    it('does NOT render stale banner when staleBanner is false', async () => {
      fetchSpy.mockResolvedValue(makeSnapshot({staleBanner: false}))

      render(<Monitoring />)

      await waitFor(() => {
        expect(screen.getByTestId('monitoring-view')).toBeInTheDocument()
      })
      expect(screen.queryByText(/Showing cached data/)).not.toBeInTheDocument()
    })

    it('renders drift notice when driftCount > 0', async () => {
      fetchSpy.mockResolvedValue(makeSnapshot({driftCount: 42}))

      render(<Monitoring />)

      await waitFor(() => {
        expect(screen.getByTestId('monitoring-view')).toBeInTheDocument()
      })
      expect(screen.getByText(/42 repos.*not in public metadata/)).toBeInTheDocument()
    })
  })

  describe('error handling', () => {
    it('renders error state on fetch failure — no unfiltered union, no leak', async () => {
      fetchSpy.mockRejectedValue(new Error('Network offline'))

      render(<Monitoring />)

      await waitFor(() => {
        expect(screen.getByTestId('monitoring-error')).toBeInTheDocument()
      })
      expect(screen.getByText(/Unable to load monitoring data/)).toBeInTheDocument()
      expect(screen.getByText(/Network offline/)).toBeInTheDocument()

      // Fails closed — does not render the view or any fake repos
      expect(screen.queryByTestId('monitoring-view')).not.toBeInTheDocument()
    })

    it('renders error state on network failure', async () => {
      fetchSpy.mockRejectedValue(new Error('Failed to fetch'))

      render(<Monitoring />)

      await waitFor(() => {
        expect(screen.getByTestId('monitoring-error')).toBeInTheDocument()
      })
      expect(screen.getByText('Failed to fetch')).toBeInTheDocument()
    })

    it('renders empty state — not a dead screen (no throw)', async () => {
      fetchSpy.mockResolvedValue(makeSnapshot({repos: []})) // missing refreshedAt but it matches partial

      render(<Monitoring />)

      await waitFor(() => {
        expect(screen.getByTestId('monitoring-empty')).toBeInTheDocument()
      })
    })

    it('error state has role=alert for accessibility', async () => {
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

      fetchSpy.mockResolvedValue(makeSnapshot({repos: [leakedRepo], refreshedAt: 1_700_000_000_000}))

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

      fetchSpy.mockResolvedValue(makeSnapshot({repos: [leakedRepo], refreshedAt: 1_700_000_000_000}))

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
