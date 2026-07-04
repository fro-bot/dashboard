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

import {useEffect, useRef, useState} from 'react'
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
  /**
   * When true, the operator shell is in fixture mode. Renders a visible
   * fixture-mode indicator and a scenario selector. Only active in dev builds.
   */
  readonly fixtureMode?: boolean
  /**
   * The fixture endpoint base to use when fixtureMode is true.
   * Passed through to the runtime seam.
   */
  readonly fixtureEndpointBase?: string
  /**
   * The fixture session ID from the fixture session response.
   * Passed through to the runtime seam for inclusion in launch requests.
   */
  readonly fixtureSessionId?: string
}

export function Operator({state = 'loading', onRuntimeStateChange, fixtureMode, fixtureEndpointBase, fixtureSessionId}: OperatorProps) {
  const headline = getStateHeadline(state)
  const detail = getStateDetail(state)
  const actionReason = getStateActionReason(state)
  const recoveryHint = getStateRecoveryHint(state)
  const actionsDisabled = isActionDisabled(state)

  // Controlled scenario state so getScenario() reads the current value at submit time.
  const [scenario, setScenario] = useState('success')
  // Stable ref so getScenario closure always reads the latest value without
  // causing the runtime effect to re-run on every scenario change.
  const scenarioRef = useRef(scenario)
  scenarioRef.current = scenario

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
      fixtureMode,
      fixtureEndpointBase,
      fixtureSessionId,
      getScenario: fixtureMode === true ? () => scenarioRef.current : undefined,
    })

    runtimeHandleRef.current = handle

    return () => {
      handle.cleanup()
      runtimeHandleRef.current = null
    }
  }, [state, fixtureMode, fixtureEndpointBase, fixtureSessionId])

  return (
    <div data-testid="operator-shell" data-state={state} {...(fixtureMode === true ? {'data-fixture-mode': 'true'} : {})}>
      {fixtureMode === true && (
        <div
          data-testid="fixture-mode-indicator"
          role="status"
          aria-label="Fixture mode active"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            padding: 'var(--space-2) var(--space-3)',
            marginBottom: 'var(--space-4)',
            background: 'var(--color-surface-overlay)',
            border: '1px solid var(--color-warning)',
            borderRadius: 'var(--radius-md)',
            fontSize: 'var(--text-label)',
            fontWeight: 600,
            letterSpacing: 'var(--tracking-label)',
            color: 'var(--color-warning)',
            textTransform: 'uppercase',
          }}
        >
          <span aria-hidden="true">⚠</span>
          <span>Local fixture mode — all data is synthetic</span>
        </div>
      )}
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
          <section
            data-testid="recent-runs-section"
            data-role="run-index"
            className="operator-panel"
            aria-label="Recent runs"
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
              Recent Runs
            </h2>

            <div
              data-role="run-index-loading"
              aria-live="polite"
              aria-atomic="true"
              aria-label="Recent runs loading"
              style={{
                fontSize: 'var(--text-body-sm)',
                color: 'var(--color-text-muted)',
              }}
            />

            <div
              data-role="run-index-list"
              aria-label="Recent run list"
            />

            <div
              data-role="run-index-empty"
              hidden
              style={{
                fontSize: 'var(--text-body-sm)',
                color: 'var(--color-text-muted)',
              }}
            />

            <div
              data-role="run-index-unavailable"
              hidden
              style={{
                fontSize: 'var(--text-body-sm)',
                color: 'var(--color-text-muted)',
              }}
            />

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

            {fixtureMode === true && (
              <div style={{marginBottom: 'var(--space-4)'}}>
                <label
                  htmlFor="fixture-scenario-select"
                  style={{
                    display: 'block',
                    fontSize: 'var(--text-body-sm)',
                    fontWeight: 500,
                    color: 'var(--color-text-muted)',
                    marginBottom: 'var(--space-1)',
                  }}
                >
                  Fixture scenario
                </label>
                <select
                  id="fixture-scenario-select"
                  data-testid="fixture-scenario-select"
                  className="operator-input"
                  style={{width: 'auto', minWidth: '220px'}}
                  value={scenario}
                  onChange={e => { setScenario(e.target.value) }}
                >
                  <option value="success">Success</option>
                  <option value="terminal_failure">Terminal failure</option>
                  <option value="contract_drift">Contract drift</option>
                  <option value="malformed_unavailable">Malformed / unavailable</option>
                </select>
              </div>
            )}

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
        </div>
      )}
    </div>
  )
}
