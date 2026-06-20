/**
 * Operator workflow UI skeleton — SSR route.
 *
 * MOCK-ONLY: renders entirely from injected fixtures via the typed OperatorClient
 * contract. ZERO production Gateway calls. ZERO live /operator/* network calls.
 * No DOM EventSource.
 *
 * Security invariants:
 * - All dynamic values escaped via hono/html auto-escaping (html`` tag).
 * - Never renders raw prompts, tool args, workspace paths, internal URLs,
 *   tokens, session cookies, or CSRF values.
 * - Copy distinguishes "signed in to dashboard" from "Gateway operator session".
 * - Disabled controls have text reasons, not color-only.
 * - No disabled-but-focusable fake controls.
 * - Decision buttons have explicit labels.
 * - Keyboard-reachable approval cards.
 *
 * This route is protected by the auth middleware in server.ts.
 * It is NOT a public path — do NOT add it to isPublicPath.
 */
import type {ApprovalDecisionState, RunStatus} from '../gateway/operator-client.ts'
import {Hono} from 'hono'
import {html} from 'hono/html'

import {approvalStateLabel, runStatusLabel, streamEventLabel} from '../gateway/operator-copy.ts'
import {ALL_FIXTURE_RUNS, FIXTURE_DECISION_ALREADY_CLAIMED, FIXTURE_DECISION_CLAIMED, FIXTURE_DECISION_FAILED_TO_SETTLE, FIXTURE_DECISION_PENDING, FIXTURE_DECISION_SCOPE_MISMATCH, FIXTURE_DECISION_UNAVAILABLE, FIXTURE_PENDING_APPROVAL, FIXTURE_RUN_TIMELINE} from '../gateway/operator-fixtures.ts'

// ---------------------------------------------------------------------------
// Status pill helper
// ---------------------------------------------------------------------------

function runStatusClass(status: RunStatus): string {
  switch (status) {
    case 'queued': return 'status-queued'
    case 'running': return 'status-running'
    case 'waiting_for_approval': return 'status-waiting'
    case 'blocked': return 'status-blocked'
    case 'failed': return 'status-failed'
    case 'cancelled': return 'status-cancelled'
    case 'succeeded': return 'status-succeeded'
  }
}

// ---------------------------------------------------------------------------
// Page sections
// ---------------------------------------------------------------------------

function gatewayAuthSection(gatewaySessionEnabled: boolean): ReturnType<typeof html> {
  if (gatewaySessionEnabled) {
    return html`
      <section class="section" aria-labelledby="gateway-auth-heading">
        <h2 id="gateway-auth-heading">Gateway Operator Session</h2>
        <div class="notice">
          <strong>Your gateway session governs operator access.</strong>
          The gateway session is the single authority for operator actions on this page.
          Signing in to the dashboard does not authorize gateway actions — operator
          authorization is determined solely by the gateway operator session.
        </div>
        <p style="font-size:0.875rem;color:#6b7280;margin-bottom:0;">
          Gateway controls are available when a valid gateway operator session is present.
          If you lose access, sign in again through the gateway.
        </p>
      </section>
    `
  }

  return html`
    <section class="section" aria-labelledby="gateway-auth-heading">
      <h2 id="gateway-auth-heading">Gateway Operator Session</h2>
      <div class="notice">
        <strong>Dashboard sign-in is separate from Gateway sign-in.</strong>
        You are signed in to the monitoring dashboard, but Gateway operator access
        requires a separate Gateway session. Gateway authentication is not yet available
        in this skeleton — this panel shows the unauthenticated state.
      </div>
      <p style="font-size:0.875rem;color:#6b7280;margin-bottom:12px;">
        Gateway controls are unavailable until a Gateway operator session is established.
        Gateway sign-in will be available once Gateway operator authentication is ready.
      </p>
      <p class="unavailable" style="margin-bottom:0;">
        <strong>Gateway operator session:</strong> Not signed in to Gateway
        <br />
        <span style="font-size:0.8rem;">
          Note: Signing in to the dashboard does not authorize Gateway actions.
          Gateway operator access requires a separate Gateway session.
        </span>
      </p>
    </section>
  `
}

function launchSection(): ReturnType<typeof html> {
  return html`
    <section class="section" aria-labelledby="launch-heading">
      <h2 id="launch-heading">Launch Run <span class="badge-mock">Mock skeleton</span></h2>
      <div class="warning">
        <strong>Launch not ready:</strong> Gateway launch controls are unavailable.
        This form is shown as a skeleton only — no runs can be submitted until
        Gateway launch is available.
      </div>
      <form aria-disabled="true" style="opacity:0.6;">
        <fieldset disabled style="border:none;padding:0;">
          <legend style="font-size:0.875rem;font-weight:600;margin-bottom:8px;color:#374151;">
            Launch a new run (unavailable — Gateway launch not ready)
          </legend>
          <div style="margin-bottom:10px;">
            <label for="launch-owner" style="display:block;font-size:0.8rem;font-weight:600;margin-bottom:4px;color:#374151;">
              Owner
            </label>
            <input
              id="launch-owner"
              type="text"
              value="fro-bot"
              disabled
              aria-describedby="launch-disabled-reason"
              style="width:100%;max-width:300px;padding:6px 10px;border:1px solid #d1d5db;border-radius:4px;font-size:0.875rem;background:#f9fafb;color:#9ca3af;"
            />
          </div>
          <div style="margin-bottom:10px;">
            <label for="launch-repo" style="display:block;font-size:0.8rem;font-weight:600;margin-bottom:4px;color:#374151;">
              Repository
            </label>
            <input
              id="launch-repo"
              type="text"
              value="agent"
              disabled
              aria-describedby="launch-disabled-reason"
              style="width:100%;max-width:300px;padding:6px 10px;border:1px solid #d1d5db;border-radius:4px;font-size:0.875rem;background:#f9fafb;color:#9ca3af;"
            />
          </div>
          <p id="launch-disabled-reason" style="font-size:0.8rem;color:#9ca3af;margin-top:4px;">
            Launch is disabled: the Gateway launch route is not yet available.
          </p>
        </fieldset>
      </form>
    </section>
  `
}

function runStatusSection(): ReturnType<typeof html> {
  const runCards = ALL_FIXTURE_RUNS.map(async run => {
    const label = runStatusLabel(run.status)
    const cssClass = runStatusClass(run.status)
    return html`
      <div class="run-card" tabindex="0" aria-label="Run ${run.runId}, status: ${label}">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
          <span class="run-status ${cssClass}">${label}</span>
          <span class="mono">${run.runId}</span>
        </div>
        <div style="font-size:0.8rem;color:#6b7280;">
          <span>${run.owner}/${run.repo}</span>
          · <span>Created: ${run.createdAt}</span>
          ${run.updatedAt == null ? '' : html` · <span>Updated: ${run.updatedAt}</span>`}
        </div>
      </div>
    `
  })

  return html`
    <section class="section" aria-labelledby="runs-heading">
      <h2 id="runs-heading">Run Status <span class="badge-mock">Mock skeleton — fixture data</span></h2>
      <div class="notice" style="margin-bottom:16px;">
        Live run observation is unavailable. This panel shows fixture data representing
        all possible run states. Live run streaming will be available once Gateway
        run observation is ready.
      </div>
      ${runCards}
    </section>
  `
}

function eventTimelineSection(): ReturnType<typeof html> {
  const eventItems = FIXTURE_RUN_TIMELINE.map(async event => {
    // Use safe human-readable label — never render raw event type tokens
    // (raw tokens like 'approval.failed_to_settle' must not appear in HTML)
    const label = streamEventLabel(event.type)
    return html`
      <li>
        <span>${label}</span>
      </li>
    `
  })

  return html`
    <section class="section" aria-labelledby="timeline-heading">
      <h2 id="timeline-heading">Run Event Timeline <span class="badge-mock">Mock skeleton — fixture events</span></h2>
      <div class="notice" style="margin-bottom:12px;">
        This timeline shows fixture events only. Live run streaming is unavailable
        until Gateway run observation is ready. No real /operator/* calls are made.
      </div>
      <ul class="timeline" aria-label="Run event timeline (fixture data)">
        ${eventItems}
      </ul>
    </section>
  `
}

function pendingApprovalSection(): ReturnType<typeof html> {
  const approval = FIXTURE_PENDING_APPROVAL
  return html`
    <section class="section" aria-labelledby="approvals-heading">
      <h2 id="approvals-heading">Pending Approvals <span class="badge-mock">Mock skeleton — fixture data</span></h2>
      <div class="notice" style="margin-bottom:16px;">
        Approval controls are unavailable. This panel shows fixture data.
        Live approval actions will be available once Gateway approvals are ready
        and CSRF is present.
      </div>

      <div class="approval-card" tabindex="0" aria-labelledby="approval-pending-heading">
        <h3 id="approval-pending-heading">Approval Request (Pending)</h3>
        <p style="font-size:0.875rem;margin-bottom:8px;">
          <strong>Request ID:</strong> <span class="mono">${approval.requestId}</span>
        </p>
        <p style="font-size:0.875rem;margin-bottom:8px;">
          <strong>Run:</strong> <span class="mono">${approval.runId}</span>
        </p>
        <p style="font-size:0.875rem;margin-bottom:12px;">
          <strong>Summary:</strong> ${approval.safeSummary}
        </p>
        <div style="display:flex;gap:10px;align-items:center;">
          <button
            type="button"
            class="btn btn-disabled"
            disabled
            aria-disabled="true"
            aria-describedby="approval-disabled-reason"
          >
            Approve
          </button>
          <button
            type="button"
            class="btn btn-disabled"
            disabled
            aria-disabled="true"
            aria-describedby="approval-disabled-reason"
          >
            Reject
          </button>
        </div>
        <p id="approval-disabled-reason" style="font-size:0.8rem;color:#9ca3af;margin-top:8px;">
          Approval actions are disabled: the Gateway approval route is not yet
          available and CSRF is not present.
        </p>
      </div>

      <h3 style="margin-top:16px;margin-bottom:8px;">Approval Decision States</h3>
      <p style="font-size:0.8rem;color:#6b7280;margin-bottom:10px;">
        The following cards show all canonical approval decision states (non-actionable in this skeleton).
        Note: the &ldquo;Decision already in progress&rdquo; state is in-flight (not terminal) —
        a second decision arrived while the first POST was still in-flight.
      </p>

      ${terminalApprovalCard(FIXTURE_DECISION_PENDING)}
      ${terminalApprovalCard(FIXTURE_DECISION_CLAIMED)}
      ${terminalApprovalCard(FIXTURE_DECISION_ALREADY_CLAIMED)}
      ${terminalApprovalCard(FIXTURE_DECISION_SCOPE_MISMATCH)}
      ${terminalApprovalCard(FIXTURE_DECISION_FAILED_TO_SETTLE)}
      ${terminalApprovalCard(FIXTURE_DECISION_UNAVAILABLE)}
    </section>
  `
}

function terminalApprovalCard(decision: {
  state: ApprovalDecisionState
  requestId: string
  timestamp: string
}): ReturnType<typeof html> {
  // approvalStateLabel maps all states to safe copy — failed_to_settle never shown raw
  const label = approvalStateLabel(decision.state)
  return html`
    <div class="approval-terminal" tabindex="0" aria-label="Approval ${decision.requestId}: ${label}">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
        <strong style="font-size:0.875rem;">${label}</strong>
      </div>
      <div style="font-size:0.8rem;">
        <span>Request: <span class="mono">${decision.requestId}</span></span>
        · <span>At: ${decision.timestamp}</span>
      </div>
    </div>
  `
}

function bindingUnavailableSection(): ReturnType<typeof html> {
  return html`
    <section class="section" aria-labelledby="binding-heading">
      <h2 id="binding-heading">Gateway Repository Selection</h2>
      <div class="unavailable">
        <strong>Gateway repository selection unavailable.</strong>
        Gateway-backed repository selection requires Gateway repository binding,
        which is not yet available. The monitoring repository table above remains
        independent and is not affected by this limitation.
      </div>
      <p style="font-size:0.8rem;color:#6b7280;">
        Note: Repositories visible in the monitoring dashboard are not automatically
        available for Gateway launch. Gateway repository authorization is separate
        from dashboard monitoring access.
      </p>
    </section>
  `
}

// ---------------------------------------------------------------------------
// Full page
// ---------------------------------------------------------------------------

function operatorPage(gatewaySessionEnabled: boolean): ReturnType<typeof html> {
  return html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Fro Bot — Gateway Operator Controls (Skeleton)</title>
  <link rel="stylesheet" href="/static/operator.css" />
</head>
<body>
  <p class="back"><a href="/">← Back to monitoring dashboard</a></p>
  <h1>Gateway Operator Controls <span class="badge-mock">Mock skeleton</span></h1>
  <p class="meta">
    This is a mock-only skeleton. All data is from fixtures.
    No live Gateway calls are made. Gateway controls are pending readiness.
  </p>

  ${gatewayAuthSection(gatewaySessionEnabled)}
  ${launchSection()}
  ${runStatusSection()}
  ${eventTimelineSection()}
  ${pendingApprovalSection()}
  ${bindingUnavailableSection()}

  <p style="margin-top:24px;font-size:0.8rem;color:#6b7280;">
    <a href="/">← Back to monitoring dashboard</a>
  </p>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

/**
 * Builds the operator UI skeleton SSR router.
 * Mounted at /operator in server.ts — auth middleware is applied upstream.
 * Only mounted when operatorUiEnabled is true.
 *
 * @param gatewaySessionEnabled - When true, the gateway operator session is the
 *   authority for operator actions and the page copy reflects that. When false
 *   (default), the Arctic session governs and the page shows the separate-domains
 *   wording accurate for that mode.
 */
export function buildOperatorRouter(gatewaySessionEnabled: boolean): Hono {
  const router = new Hono()

  router.get('/', async c => {
    return c.html(operatorPage(gatewaySessionEnabled))
  })

  return router
}
