/**
 * Operator — root operator app shell view.
 *
 * Renders the operator surface at `/`. Accepts an optional `state` prop
 * from the canonical operator state classifier. Defaults to `loading`.
 *
 * Accessibility:
 * - aria-live="polite" region for state changes (announced to screen readers).
 * - Visible action-disabled reason when actions are not available.
 *
 * Security invariants:
 * - No raw response body, URL, prompt, token, cookie, CSRF value, repo name,
 *   run ID, or stack trace in rendered text.
 * - All copy comes from the fixed copy module — never interpolated from signals.
 */

import {getStateActionReason, getStateDetail, getStateHeadline, getStateRecoveryHint} from '../operator/copy.ts'
import {isActionDisabled} from '../operator/state.ts'
import type {OperatorState} from '../operator/state.ts'

interface OperatorProps {
  /** Current operator state from the canonical classifier. Defaults to `loading`. */
  readonly state?: OperatorState
}

export function Operator({state = 'loading'}: OperatorProps) {
  const headline = getStateHeadline(state)
  const detail = getStateDetail(state)
  const actionReason = getStateActionReason(state)
  const recoveryHint = getStateRecoveryHint(state)
  const actionsDisabled = isActionDisabled(state)

  return (
    <div data-testid="operator-shell">
      <h1
        style={{
          fontSize: 'var(--text-h3)',
          fontWeight: 700,
          letterSpacing: 'var(--tracking-heading)',
          color: 'var(--color-text)',
          marginBottom: 'var(--space-4)',
        }}
      >
        {headline}
      </h1>

      {/* aria-live region — announces state changes to screen readers */}
      <div
        aria-live="polite"
        aria-atomic="true"
        data-testid="operator-status-region"
        style={{
          fontSize: 'var(--text-body-sm)',
          color: 'var(--color-text-muted)',
          marginBottom: 'var(--space-4)',
        }}
      >
        <p>{detail}</p>
        {recoveryHint.length > 0 && (
          <p style={{marginTop: 'var(--space-1)'}}>{recoveryHint}</p>
        )}
      </div>

      {actionsDisabled && actionReason !== null && (
        <div
          data-testid="operator-action-reason"
          role="status"
          style={{
            fontSize: 'var(--text-body-sm)',
            color: 'var(--color-text-muted)',
            backgroundColor: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            padding: 'var(--space-3) var(--space-4)',
            marginBottom: 'var(--space-4)',
          }}
        >
          {actionReason}
        </div>
      )}

      {state === 'ready' && (
        <div
          data-testid="operator-content"
          style={{
            backgroundColor: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-lg)',
            padding: 'var(--space-8)',
            color: 'var(--color-text-muted)',
            fontSize: 'var(--text-body-sm)',
          }}
        >
          <p>Operator runtime ready.</p>
          <p style={{marginTop: 'var(--space-2)'}}>Live runs will appear here when available.</p>
        </div>
      )}
    </div>
  )
}
