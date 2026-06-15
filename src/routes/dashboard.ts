/**
 * Dashboard SSR route — glanceable, attention-first view of the aggregator snapshot.
 *
 * Uses hono/html tagged template literals for SSR — no JSX, no build step.
 * Compatible with Node 24+ native TS (strip-only).
 *
 * Security invariants:
 * - All dynamic values are escaped via hono/html's auto-escaping (html`` tag).
 * - node_id is never rendered as user-facing identity.
 * - Drift count is rendered as a number only — never repo names or node_ids.
 * - This route is protected by the auth middleware in server.ts.
 */
import type {AggregatorSnapshot, DashboardRepo} from '../github/aggregator.ts'
import {Hono} from 'hono'
import {html, raw} from 'hono/html'

/** Injectable snapshot provider — returns the current aggregator snapshot. */
export type SnapshotProvider = () => AggregatorSnapshot

/** Config for building the dashboard router. */
export interface DashboardRouterConfig {
  readonly getSnapshot: SnapshotProvider
}

// ---------------------------------------------------------------------------
// Status pill helpers
// ---------------------------------------------------------------------------

type RollupState = 'green' | 'red' | 'pending' | 'unknown'

function pillColor(state: RollupState): string {
  if (state === 'green') return '#22c55e'
  if (state === 'red') return '#ef4444'
  if (state === 'pending') return '#f59e0b'
  return '#6b7280'
}

function pillLabel(state: RollupState): string {
  if (state === 'green') return '✓ green'
  if (state === 'red') return '✗ red'
  if (state === 'pending') return '⏳ pending'
  return '? unknown'
}

// ---------------------------------------------------------------------------
// HTML fragment builders
// ---------------------------------------------------------------------------

function statusPill(state: RollupState): string {
  const color = pillColor(state)
  const label = pillLabel(state)
  return `<span style="display:inline-block;padding:2px 8px;border-radius:9999px;background:${color};color:#fff;font-size:0.75rem;font-weight:600;white-space:nowrap;">${label}</span>`
}

function channelBadge(channel: string): ReturnType<typeof html> {
  return html`<span style="display:inline-block;padding:1px 6px;border-radius:4px;background:#e5e7eb;color:#374151;font-size:0.7rem;font-family:monospace;">${channel}</span>`
}

function repoRow(repo: DashboardRepo): ReturnType<typeof html> {
  const fullName = repo.full_name
  const channel = repo.discovery_channel
  const {status} = repo
  const ghBase = `https://github.com/${fullName}`
  const alertDisplay = status.openAlertCount === null ? '—' : String(status.openAlertCount)
  const staleMarker = status.stale
    ? raw('<span style="margin-left:6px;font-size:0.7rem;color:#b45309;background:#fef3c7;padding:1px 5px;border-radius:4px;">stale</span>')
    : ''

  return html`
    <tr style="border-bottom:1px solid #e5e7eb;">
      <td style="padding:10px 12px;">
        <a href="${ghBase}" rel="noopener noreferrer" style="font-weight:600;color:#1d4ed8;text-decoration:none;">${fullName}</a>
        ${staleMarker}
      </td>
      <td style="padding:10px 12px;text-align:center;">${raw(statusPill(status.rollupState))}</td>
      <td style="padding:10px 12px;text-align:center;color:#374151;">${status.failingChecks}</td>
      <td style="padding:10px 12px;text-align:center;"><a href="${ghBase}/pulls" rel="noopener noreferrer" style="color:#1d4ed8;">${status.openPrCount}</a></td>
      <td style="padding:10px 12px;text-align:center;"><a href="${ghBase}/issues" rel="noopener noreferrer" style="color:#1d4ed8;">${status.openIssueCount}</a></td>
      <td style="padding:10px 12px;text-align:center;color:#374151;">${alertDisplay}</td>
      <td style="padding:10px 12px;text-align:center;">${channelBadge(channel)}</td>
    </tr>
  `
}

const PAGE_STYLES = `
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,sans-serif;background:#f9fafb;color:#111827;padding:24px}
  h1{font-size:1.5rem;font-weight:700;margin-bottom:4px}
  .meta{font-size:0.8rem;color:#6b7280;margin-bottom:16px}
  .banner{background:#fef2f2;border:1px solid #fca5a5;color:#991b1b;padding:12px 16px;border-radius:6px;margin-bottom:16px;font-weight:600}
  .drift{background:#fffbeb;border:1px solid #fcd34d;color:#92400e;padding:10px 16px;border-radius:6px;margin-bottom:16px;font-size:0.875rem}
  .empty{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:48px;text-align:center;color:#6b7280}
  table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)}
  th{background:#f3f4f6;padding:10px 12px;text-align:left;font-size:0.75rem;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.05em}
  th.center{text-align:center}
  a{color:#1d4ed8}
  .refresh{margin-top:16px;font-size:0.8rem;color:#6b7280}
`

function dashboardPage(snapshot: AggregatorSnapshot): ReturnType<typeof html> {
  const {repos, staleBanner, driftCount, refreshedAt} = snapshot
  const isEmpty = repos.length === 0 && refreshedAt === null

  const refreshedLabel =
    refreshedAt === null
      ? 'never'
      : new Date(refreshedAt).toISOString()

  const driftSuffix = driftCount === 1 ? '' : 's'

  const staleBannerHtml = staleBanner
    ? raw('<div class="banner" role="alert">⚠ Showing cached data — live refresh unavailable</div>')
    : ''

  const driftHtml =
    driftCount > 0
      ? html`<div class="drift">ℹ ${driftCount} repo${driftSuffix} the Agent App can see are not in public metadata</div>`
      : ''

  const bodyContent = isEmpty
    ? raw(`
        <div class="empty">
          <p style="font-size:1.1rem;margin-bottom:8px;">Loading… / no data yet</p>
          <p style="font-size:0.875rem;">The aggregator has not completed its first refresh.</p>
        </div>
      `)
    : html`
        <table>
          <thead>
            <tr>
              <th>Repository</th>
              <th class="center">Status</th>
              <th class="center">Failing checks</th>
              <th class="center">Open PRs</th>
              <th class="center">Open issues</th>
              <th class="center">Alerts</th>
              <th class="center">Channel</th>
            </tr>
          </thead>
          <tbody>
            ${repos.map(async repo => repoRow(repo))}
          </tbody>
        </table>
      `

  return html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Fro Bot Dashboard</title>
  <style>${raw(PAGE_STYLES)}</style>
</head>
<body>
  <h1>Fro Bot Dashboard</h1>
  <p class="meta">Last refreshed: ${refreshedLabel}</p>
  ${staleBannerHtml}
  ${driftHtml}
  ${bodyContent}
  <p class="refresh">
    <a href="/">↻ Refresh</a>
    · <a href="/auth/logout" style="color:#6b7280;">Logout</a>
  </p>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

/**
 * Builds the dashboard SSR router.
 * Mounted at `/` in server.ts — auth middleware is applied upstream.
 */
export function buildDashboardRouter(config: DashboardRouterConfig): Hono {
  const {getSnapshot} = config
  const router = new Hono()

  router.get('/', async c => {
    const snapshot = getSnapshot()
    return c.html(dashboardPage(snapshot))
  })

  return router
}
