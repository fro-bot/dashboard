/**
 * Monitoring view — responsive repo/status card grid.
 *
 * Fetches the already-redacted aggregation snapshot from the BFF (/api/monitoring)
 * and renders repo cards with status badges. All colors come from CSS tokens —
 * no inline hex, no ad-hoc colors.
 *
 * Security invariants:
 * - NO dangerouslySetInnerHTML anywhere. All dynamic strings are React text (auto-escaped).
 * - The BFF guarantees redaction. This view is display-only.
 * - node_id is used as React key only — never rendered as visible text.
 * - Aggregation failure → fail-closed (no unfiltered union, no leak).
 * - Empty/stale snapshot → labeled state, not a dead screen.
 */

import {useEffect, useState} from 'react'
import {type AggregatorSnapshot, type CiRollupState, type DashboardRepo, fetchAggregationSnapshot} from '../api/aggregation.ts'

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

interface StatusBadgeProps {
  readonly state: CiRollupState
}

function rollupLabel(state: CiRollupState): string {
  if (state === 'green') return '✓ green'
  if (state === 'red') return '✗ red'
  if (state === 'pending') return '⏳ pending'
  return '? unknown'
}

function rollupColorVar(state: CiRollupState): string {
  if (state === 'green') return 'var(--color-success)'
  if (state === 'red') return 'var(--color-error)'
  if (state === 'pending') return 'var(--color-warning)'
  return 'var(--color-text-muted)'
}

function StatusBadge({state}: StatusBadgeProps) {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: 'var(--space-1) var(--space-2)',
        borderRadius: 'var(--radius-full)',
        backgroundColor: rollupColorVar(state),
        color: 'var(--color-bg)',
        fontSize: 'var(--text-label)',
        fontWeight: 700,
        whiteSpace: 'nowrap',
        letterSpacing: 'var(--tracking-label)',
      }}
    >
      {rollupLabel(state)}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Channel badge
// ---------------------------------------------------------------------------

interface ChannelBadgeProps {
  readonly channel: string
}

function ChannelBadge({channel}: ChannelBadgeProps) {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px var(--space-2)',
        borderRadius: 'var(--radius-sm)',
        backgroundColor: 'var(--color-surface-raised)',
        color: 'var(--color-text-muted)',
        fontSize: 'var(--text-label)',
        fontFamily: 'var(--font-mono)',
        letterSpacing: 'var(--tracking-code)',
        border: '1px solid var(--color-border-muted)',
      }}
    >
      {channel}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Repo card
// ---------------------------------------------------------------------------

interface RepoCardProps {
  readonly repo: DashboardRepo
}

function RepoCard({repo}: RepoCardProps) {
  const {full_name, discovery_channel, status} = repo
  const ghBase = `https://github.com/${full_name}`
  const alertDisplay = status.openAlertCount === null ? '—' : String(status.openAlertCount)

  return (
    <div
      style={{
        backgroundColor: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
        padding: 'var(--space-4)',
        boxShadow: 'var(--shadow-sm)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-3)',
      }}
    >
      {/* Header row: repo name + status badge */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 'var(--space-2)',
          flexWrap: 'wrap',
        }}
      >
        <div style={{display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap'}}>
          <a
            href={ghBase}
            rel="noopener noreferrer"
            style={{
              fontWeight: 700,
              fontSize: 'var(--text-body)',
              color: 'var(--color-accent)',
              textDecoration: 'none',
              letterSpacing: 'var(--tracking-body)',
            }}
          >
            {full_name}
          </a>
          {status.stale && (
            <span
              style={{
                fontSize: 'var(--text-label)',
                color: 'var(--color-warning)',
                backgroundColor: 'var(--color-surface-raised)',
                padding: '1px var(--space-2)',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--color-warning)',
              }}
            >
              stale
            </span>
          )}
        </div>
        <StatusBadge state={status.rollupState} />
      </div>

      {/* Stats row */}
      <div
        style={{
          display: 'flex',
          gap: 'var(--space-4)',
          flexWrap: 'wrap',
          fontSize: 'var(--text-body-sm)',
          color: 'var(--color-text-muted)',
        }}
      >
        {status.failingChecks > 0 && (
          <span style={{color: 'var(--color-error)'}}>
            {status.failingChecks} failing check{status.failingChecks !== 1 ? 's' : ''}
          </span>
        )}
        <a
          href={`${ghBase}/pulls`}
          rel="noopener noreferrer"
          style={{color: 'var(--color-accent)', textDecoration: 'none'}}
        >
          {status.openPrCount} PR{status.openPrCount !== 1 ? 's' : ''}
        </a>
        <a
          href={`${ghBase}/issues`}
          rel="noopener noreferrer"
          style={{color: 'var(--color-accent)', textDecoration: 'none'}}
        >
          {status.openIssueCount} issue{status.openIssueCount !== 1 ? 's' : ''}
        </a>
        <span>
          {alertDisplay === '—' ? '— alerts' : `${alertDisplay} alert${status.openAlertCount !== 1 ? 's' : ''}`}
        </span>
      </div>

      {/* Footer row: channel badge */}
      <div style={{display: 'flex', alignItems: 'center', gap: 'var(--space-2)'}}>
        <ChannelBadge channel={discovery_channel} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Stale banner
// ---------------------------------------------------------------------------

function StaleBanner() {
  return (
    <div
      role="alert"
      style={{
        backgroundColor: 'var(--color-surface-raised)',
        border: '1px solid var(--color-error)',
        color: 'var(--color-error)',
        padding: 'var(--space-3) var(--space-4)',
        borderRadius: 'var(--radius-md)',
        fontWeight: 600,
        fontSize: 'var(--text-body-sm)',
        marginBottom: 'var(--space-4)',
      }}
    >
      ⚠ Showing cached data — live refresh unavailable
    </div>
  )
}

// ---------------------------------------------------------------------------
// Drift notice
// ---------------------------------------------------------------------------

interface DriftNoticeProps {
  readonly count: number
}

function DriftNotice({count}: DriftNoticeProps) {
  const suffix = count === 1 ? '' : 's'
  return (
    <div
      style={{
        backgroundColor: 'var(--color-surface)',
        border: '1px solid var(--color-warning)',
        color: 'var(--color-warning)',
        padding: 'var(--space-3) var(--space-4)',
        borderRadius: 'var(--radius-md)',
        fontSize: 'var(--text-body-sm)',
        marginBottom: 'var(--space-4)',
      }}
    >
      ℹ {count} repo{suffix} the Agent App can see are not in public metadata
    </div>
  )
}

// ---------------------------------------------------------------------------
// Empty / loading state
// ---------------------------------------------------------------------------

function EmptyState() {
  return (
    <div
      data-testid="monitoring-empty"
      style={{
        backgroundColor: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
        padding: 'var(--space-12)',
        textAlign: 'center',
        color: 'var(--color-text-muted)',
      }}
    >
      <p style={{fontSize: 'var(--text-body-lg)', marginBottom: 'var(--space-2)'}}>
        Loading… / no data yet
      </p>
      <p style={{fontSize: 'var(--text-body-sm)'}}>
        The aggregator has not completed its first refresh.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Error state (fail-closed)
// ---------------------------------------------------------------------------

interface ErrorStateProps {
  readonly message: string
}

function ErrorState({message}: ErrorStateProps) {
  return (
    <div
      data-testid="monitoring-error"
      role="alert"
      style={{
        backgroundColor: 'var(--color-surface)',
        border: '1px solid var(--color-error)',
        borderRadius: 'var(--radius-lg)',
        padding: 'var(--space-8)',
        textAlign: 'center',
        color: 'var(--color-error)',
      }}
    >
      <p style={{fontSize: 'var(--text-body-lg)', fontWeight: 600, marginBottom: 'var(--space-2)'}}>
        Unable to load monitoring data
      </p>
      <p style={{fontSize: 'var(--text-body-sm)', color: 'var(--color-text-muted)'}}>
        {message}
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Monitoring view
// ---------------------------------------------------------------------------

type FetchState =
  | {readonly kind: 'loading'}
  | {readonly kind: 'error'; readonly message: string}
  | {readonly kind: 'ok'; readonly snapshot: AggregatorSnapshot}

/**
 * Monitoring view — fetches the BFF aggregation snapshot and renders repo cards.
 *
 * Fail-closed: on any fetch error, renders an error state (no unfiltered union,
 * no leak). Empty snapshot renders a labeled loading state, not a dead screen.
 */
export function Monitoring() {
  const [state, setState] = useState<FetchState>({kind: 'loading'})

  useEffect(() => {
    let cancelled = false

    fetchAggregationSnapshot()
      .then(snapshot => {
        if (!cancelled) {
          setState({kind: 'ok', snapshot})
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          const message =
            error instanceof Error ? error.message : 'Unknown error fetching monitoring data'
          setState({kind: 'error', message})
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  if (state.kind === 'loading') {
    return (
      <div data-testid="monitoring-loading" style={{color: 'var(--color-text-muted)', padding: 'var(--space-8)'}}>
        Loading monitoring data…
      </div>
    )
  }

  if (state.kind === 'error') {
    return <ErrorState message={state.message} />
  }

  const {snapshot} = state
  const {repos, staleBanner, driftCount, refreshedAt} = snapshot
  const isEmpty = repos.length === 0 && refreshedAt === null

  const refreshedLabel =
    refreshedAt === null ? 'never' : new Date(refreshedAt).toISOString()

  return (
    <div data-testid="monitoring-view">
      {/* Meta */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 'var(--space-4)',
          flexWrap: 'wrap',
          gap: 'var(--space-2)',
        }}
      >
        <h2
          style={{
            fontSize: 'var(--text-h3)',
            fontWeight: 700,
            letterSpacing: 'var(--tracking-heading)',
            color: 'var(--color-text)',
          }}
        >
          Repository Status
        </h2>
        <span style={{fontSize: 'var(--text-label)', color: 'var(--color-text-subtle)'}}>
          Last refreshed: {refreshedLabel}
        </span>
      </div>

      {/* Stale banner */}
      {staleBanner && <StaleBanner />}

      {/* Drift notice */}
      {driftCount > 0 && <DriftNotice count={driftCount} />}

      {/* Repo grid or empty state */}
      {isEmpty ? (
        <EmptyState />
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
            gap: 'var(--space-4)',
          }}
        >
          {repos.map(repo => (
            <RepoCard key={repo.node_id} repo={repo} />
          ))}
        </div>
      )}
    </div>
  )
}
