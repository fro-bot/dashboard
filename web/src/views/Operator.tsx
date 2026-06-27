/**
 * Operator — root operator app shell view.
 *
 * Renders the operator surface at `/`. Accepts an optional `state` prop
 * from the canonical operator state classifier. Defaults to `loading`.
 *
 * When state is `ready`, renders the operator DOM skeleton and mounts the
 * existing browser-direct operator runtimes (public/operator-*.js) via the
 * runtime seam. The runtime seam owns CSRF refresh and idempotency-key
 * generation; React does not generate or persist keys.
 *
 * Accessibility:
 * - aria-live="polite" region for state changes (announced to screen readers).
 * - Visible action-disabled reason when actions are not available.
 *
 * Security invariants:
 * - No raw response body, URL, prompt, token, cookie, CSRF value, repo name,
 *   run ID, or stack trace in rendered text.
 * - All copy comes from the fixed copy module — never interpolated from signals.
 * - No dangerouslySetInnerHTML.
 * - Dynamic Gateway data flows through safe text paths only (operator-*.js).
 */

import {useEffect, useRef} from 'react'
import {getStateActionReason, getStateDetail, getStateHeadline, getStateRecoveryHint} from '../operator/copy.ts'
import {createOperatorRuntime} from '../operator/runtime.ts'
import type {OperatorRuntimeHandle} from '../operator/runtime.ts'
import {isActionDisabled} from '../operator/state.ts'
import type {OperatorState} from '../operator/state.ts'

interface OperatorProps {
  /** Current operator state from the canonical classifier. Defaults to `loading`. */
  readonly state?: OperatorState
  /**
   * Called when the runtime seam changes the operator state (e.g. unavailable
   * when the runtime module is absent). Allows the parent to update its state.
   */
  readonly onRuntimeStateChange?: (state: OperatorState) => void
}

export function Operator({state = 'loading', onRuntimeStateChange}: OperatorProps) {
  const headline = getStateHeadline(state)
  const detail = getStateDetail(state)
  const actionReason = getStateActionReason(state)
  const recoveryHint = getStateRecoveryHint(state)
  const actionsDisabled = isActionDisabled(state)

  const contentRef = useRef<HTMLDivElement>(null)
  const runtimeHandleRef = useRef<OperatorRuntimeHandle | null>(null)
  // Stable ref for the callback so effect does not re-run on callback identity changes
  const onRuntimeStateChangeRef = useRef(onRuntimeStateChange)
  onRuntimeStateChangeRef.current = onRuntimeStateChange

  useEffect(() => {
    if (state !== 'ready') {
      if (runtimeHandleRef.current !== null) {
        runtimeHandleRef.current.cleanup()
        runtimeHandleRef.current = null
      }
      return
    }

    const container = contentRef.current
    if (container === null) return

    if (runtimeHandleRef.current !== null) {
      return
    }

    const handle = createOperatorRuntime({
      container,
      onStateChange: (newState) => {
        onRuntimeStateChangeRef.current?.(newState)
      },
    })

    runtimeHandleRef.current = handle

    return () => {
      handle.cleanup()
      runtimeHandleRef.current = null
    }
  }, [state])

  return (
      <div data-testid="operator-shell" data-state={state}>
      <div style={{ marginBottom: 'var(--space-6)' }}>
        <h1
          style={{
            fontSize: 'var(--text-h3)',
            fontWeight: 700,
            letterSpacing: 'var(--tracking-heading)',
            color: 'var(--color-text)',
            marginBottom: 'var(--space-1)',
          }}
        >
          {headline}
        </h1>

        <div
          aria-live="polite"
          aria-atomic="true"
          data-testid="operator-status-region"
          style={{
            fontSize: 'var(--text-body-sm)',
            color: 'var(--color-text-muted)',
          }}
        >
          <p>{detail}</p>
          {recoveryHint.length > 0 && (
            <p style={{marginTop: 'var(--space-1)', color: 'var(--color-text-subtle)'}}>{recoveryHint}</p>
          )}
        </div>
      </div>

      {actionsDisabled && actionReason !== null && (
        <div
          data-testid="operator-action-reason"
          role="status"
          className="operator-warning-panel"
        >
          {actionReason}
        </div>
      )}

      {state === 'ready' && (
        <div
          ref={contentRef}
          data-testid="operator-content"
        >
          <section className="operator-panel">
            <h2
              style={{
                fontSize: 'var(--text-body-lg)',
                fontWeight: 600,
                color: 'var(--color-text)',
                marginBottom: 'var(--space-4)',
                letterSpacing: 'var(--tracking-heading)',
              }}
            >
              Launch
            </h2>

            <div
              id="repo-picker-container"
              style={{marginBottom: 'var(--space-4)'}}
            />

            <form id="launch-form" style={{display: 'flex', flexDirection: 'column', gap: 'var(--space-3)'}}>
              <label
                htmlFor="launch-prompt"
                style={{
                  fontSize: 'var(--text-body-sm)',
                  fontWeight: 500,
                  color: 'var(--color-text-muted)',
                }}
              >
                Prompt
              </label>
              <textarea
                id="launch-prompt"
                name="prompt"
                className="operator-input"
                rows={3}
                placeholder="Describe what you want the agent to do…"
                style={{ resize: 'vertical' }}
              />
              <div
                id="launch-error"
                role="alert"
                hidden
                style={{
                  fontSize: 'var(--text-body-sm)',
                  color: 'var(--color-error)',
                  marginTop: 'var(--space-2)'
                }}
              />
              <button
                type="submit"
                className="operator-primary-action"
                style={{ alignSelf: 'flex-start' }}
              >
                Launch
              </button>
            </form>
          </section>

          <section
            id="run-status-section"
            className="operator-panel"
            aria-label="Run status"
          >
            <h2
              style={{
                fontSize: 'var(--text-body-lg)',
                fontWeight: 600,
                color: 'var(--color-text)',
                marginBottom: 'var(--space-4)',
                letterSpacing: 'var(--tracking-heading)',
              }}
            >
              Runs
            </h2>

            <div
              data-role="stream-status"
              role="status"
              aria-live="polite"
              hidden
              style={{
                fontSize: 'var(--text-body-sm)',
                color: 'var(--color-text-muted)',
                marginBottom: 'var(--space-2)',
              }}
            />
          </section>
        </div>
      )}
    </div>
  )
}
