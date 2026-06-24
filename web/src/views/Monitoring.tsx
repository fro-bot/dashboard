import {useEffect, useState} from 'react'
import {
  type AggregatorSnapshot,
  type CiRollupState,
  type DashboardRepo,
  fetchAggregationSnapshot,
} from '../api/aggregation.ts'

// ---------------------------------------------------------------------------
// Helpers & Types
// ---------------------------------------------------------------------------

type RepoCategory = 'failing' | 'pending' | 'stale' | 'healthy'

function getRepoCategory(repo: DashboardRepo): RepoCategory {
  if (repo.status.rollupState === 'red' || repo.status.failingChecks > 0) return 'failing'
  if (repo.status.rollupState === 'pending') return 'pending'
  if (repo.status.stale) return 'stale'
  return 'healthy'
}

type FilterState = 'all' | 'needs-attention' | 'failing' | 'pending' | 'stale' | 'healthy'

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
  readonly compact?: boolean
}

function RepoCard({repo, compact}: RepoCardProps) {
  const {full_name, discovery_channel, status} = repo
  const ghBase = `https://github.com/${full_name}`
  const alertDisplay = status.openAlertCount === null ? '—' : String(status.openAlertCount)
  const category = getRepoCategory(repo)

  let borderColor = 'var(--color-border)'
  let accentBorder = 'none'
  if (category === 'failing') {
    borderColor = 'var(--color-error)'
    accentBorder = `4px solid var(--color-error)`
  } else if (category === 'pending') {
    borderColor = 'var(--color-warning)'
    accentBorder = `4px solid var(--color-warning)`
  }

  const opacity = category === 'stale' ? 0.7 : 1

  return (
    <div
      style={{
        backgroundColor: 'var(--color-surface)',
        border: `1px solid ${borderColor}`,
        borderLeft: accentBorder !== 'none' ? accentBorder : `1px solid ${borderColor}`,
        borderRadius: 'var(--radius-lg)',
        padding: compact ? 'var(--space-3)' : 'var(--space-4)',
        boxShadow: 'var(--shadow-sm)',
        display: 'flex',
        flexDirection: 'column',
        gap: compact ? 'var(--space-2)' : 'var(--space-3)',
        opacity,
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
              fontSize: compact ? 'var(--text-body-sm)' : 'var(--text-body)',
              color: 'var(--color-accent)',
              textDecoration: 'none',
              letterSpacing: 'var(--tracking-body)',
              wordBreak: 'break-word',
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
      {!compact && (
        <div style={{display: 'flex', alignItems: 'center', gap: 'var(--space-2)'}}>
          <ChannelBadge channel={discovery_channel} />
        </div>
      )}
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
// Controls & Filters
// ---------------------------------------------------------------------------

interface ControlsProps {
  readonly counts: Record<RepoCategory, number>
  readonly filterText: string
  readonly setFilterText: (t: string) => void
  readonly filterState: FilterState
  readonly setFilterState: (s: FilterState) => void
}

const filterOptions: readonly { value: FilterState; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'needs-attention', label: 'Needs Attention' },
  { value: 'failing', label: 'Failing' },
  { value: 'pending', label: 'Pending' },
  { value: 'stale', label: 'Stale' },
  { value: 'healthy', label: 'Healthy' },
]

function MonitoringControls({
  counts,
  filterText,
  setFilterText,
  filterState,
  setFilterState,
}: ControlsProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', marginBottom: 'var(--space-6)' }}>
      <div style={{ display: 'flex', gap: 'var(--space-3)', fontSize: 'var(--text-label)', color: 'var(--color-text-muted)', flexWrap: 'wrap', fontWeight: 600 }}>
        <span style={{ color: counts.failing > 0 ? 'var(--color-error)' : undefined }}>
          {counts.failing} failing
        </span>
        <span>&middot;</span>
        <span style={{ color: counts.pending > 0 ? 'var(--color-warning)' : undefined }}>
          {counts.pending} pending
        </span>
        <span>&middot;</span>
        <span>{counts.stale} stale</span>
        <span>&middot;</span>
        <span>{counts.healthy} healthy</span>
      </div>

      <div style={{ display: 'flex', gap: 'var(--space-4)', flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          type="text"
          placeholder="Filter repos..."
          value={filterText}
          onChange={e => setFilterText(e.target.value)}
          aria-label="Filter repositories by name"
          style={{
            padding: 'var(--space-2) var(--space-3)',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--color-border)',
            backgroundColor: 'var(--color-surface)',
            color: 'var(--color-text)',
            flex: '1 1 200px',
            minWidth: 0,
            fontSize: 'var(--text-body-sm)'
          }}
        />
        
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }} role="group" aria-label="Filter by state">
          {filterOptions.map(({ value, label }) => {
            const isActive = filterState === value
            return (
              <button
                key={value}
                onClick={() => setFilterState(value)}
                aria-pressed={isActive}
                style={{
                  padding: 'var(--space-1) var(--space-3)',
                  borderRadius: 'var(--radius-full)',
                  border: '1px solid',
                  borderColor: isActive ? 'var(--color-accent)' : 'var(--color-border-muted)',
                  backgroundColor: isActive ? 'var(--color-surface-raised)' : 'transparent',
                  color: isActive ? 'var(--color-text)' : 'var(--color-text-muted)',
                  fontSize: 'var(--text-label)',
                  cursor: 'pointer',
                  fontWeight: isActive ? 600 : 400,
                  transition: 'all 0.15s ease'
                }}
              >
                {label}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Repo Grid
// ---------------------------------------------------------------------------

function RepoGrid({repos, compact}: {repos: readonly DashboardRepo[], compact?: boolean}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: compact ? 'repeat(auto-fill, minmax(280px, 1fr))' : 'repeat(auto-fill, minmax(320px, 1fr))',
        gap: compact ? 'var(--space-3)' : 'var(--space-4)',
      }}
    >
      {repos.map(repo => (
        <RepoCard key={repo.full_name} repo={repo} compact={compact} />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Monitoring view
// ---------------------------------------------------------------------------

type FetchStateStatus =
  | {readonly kind: 'loading'}
  | {readonly kind: 'error'; readonly message: string}
  | {readonly kind: 'ok'; readonly snapshot: AggregatorSnapshot}

export function Monitoring() {
  const [state, setState] = useState<FetchStateStatus>({kind: 'loading'})
  
  const [filterText, setFilterText] = useState('')
  const [filterState, setFilterState] = useState<FilterState>('all')
  const [healthyExpanded, setHealthyExpanded] = useState(false)

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
  const isEmpty = repos.length === 0

  const refreshedLabel =
    refreshedAt === null ? 'never' : new Date(refreshedAt).toISOString()

  // Calculate global counts (ignoring text filter)
  const counts: Record<RepoCategory, number> = {
    failing: 0,
    pending: 0,
    stale: 0,
    healthy: 0,
  }
  
  for (const repo of repos) {
    counts[getRepoCategory(repo)]++
  }

  // Filter repos based on text
  const textFilteredRepos = filterText.trim() === '' 
    ? repos 
    : repos.filter(r => r.full_name.toLowerCase().includes(filterText.toLowerCase()))

  // Group text-filtered repos by category
  const failingRepos = textFilteredRepos.filter(r => getRepoCategory(r) === 'failing')
  const pendingRepos = textFilteredRepos.filter(r => getRepoCategory(r) === 'pending')
  const staleRepos = textFilteredRepos.filter(r => getRepoCategory(r) === 'stale')
  const healthyRepos = textFilteredRepos.filter(r => getRepoCategory(r) === 'healthy')

  // Apply state filter to determine which sections to render
  const showFailing = ['all', 'needs-attention', 'failing'].includes(filterState)
  const showPending = ['all', 'needs-attention', 'pending'].includes(filterState)
  const showStale = ['all', 'needs-attention', 'stale'].includes(filterState)
  const showHealthy = ['all', 'healthy'].includes(filterState)

  // UX: Expand healthy section if actively searching or filtering to it specifically
  const isHealthyExpanded = healthyExpanded || filterText.trim() !== '' || filterState === 'healthy'

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
        <>
          <MonitoringControls 
            counts={counts}
            filterText={filterText}
            setFilterText={setFilterText}
            filterState={filterState}
            setFilterState={setFilterState}
          />
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
            {showFailing && failingRepos.length > 0 && (
              <section aria-label="Failing repositories">
                <RepoGrid repos={failingRepos} />
              </section>
            )}

            {showPending && pendingRepos.length > 0 && (
              <section aria-label="Pending repositories">
                <RepoGrid repos={pendingRepos} />
              </section>
            )}

            {showStale && staleRepos.length > 0 && (
              <section aria-label="Stale repositories">
                <RepoGrid repos={staleRepos} />
              </section>
            )}

            {showHealthy && healthyRepos.length > 0 && (
              <section aria-label="Healthy repositories">
                <button
                  onClick={() => setHealthyExpanded(!healthyExpanded)}
                  aria-expanded={isHealthyExpanded}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-2)',
                    background: 'none',
                    border: 'none',
                    color: 'var(--color-text)',
                    fontSize: 'var(--text-body)',
                    fontWeight: 600,
                    cursor: 'pointer',
                    padding: 'var(--space-2) 0',
                    marginBottom: isHealthyExpanded ? 'var(--space-4)' : 0,
                  }}
                >
                  <span style={{ 
                    display: 'inline-block', 
                    transform: isHealthyExpanded ? 'rotate(90deg)' : 'none', 
                    transition: 'transform 0.2s',
                    fontSize: '0.8em'
                  }}>
                    ▸
                  </span>
                  <span>{healthyRepos.length} healthy repo{healthyRepos.length !== 1 ? 's' : ''}</span>
                </button>
                
                {isHealthyExpanded && <RepoGrid repos={healthyRepos} compact />}
              </section>
            )}

            {textFilteredRepos.length === 0 && (
              <div style={{
                padding: 'var(--space-8)',
                textAlign: 'center',
                color: 'var(--color-text-muted)',
                backgroundColor: 'var(--color-surface)',
                borderRadius: 'var(--radius-lg)',
                border: '1px solid var(--color-border)'
              }}>
                No repositories match the current filters.
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
