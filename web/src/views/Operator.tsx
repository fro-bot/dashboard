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

  const [isLaunchOpen, setIsLaunchOpen] = useState(false)
  const triggerBtnRef = useRef<HTMLButtonElement>(null)
  const drawerRef = useRef<HTMLDivElement>(null)
  const formRef = useRef<HTMLFormElement>(null)

  // Single source of truth for closing the drawer and returning focus to the
  // trigger button — used by the close button, the backdrop, and Escape alike
  // so the three affordances can't drift out of sync.
  const closeDrawer = () => {
    setIsLaunchOpen(false)
    triggerBtnRef.current?.focus()
  }

  // Escape to close drawer
  useEffect(() => {
    if (!isLaunchOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeDrawer()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isLaunchOpen])

  // Focus the first interactive element or input inside drawer when opened
  useEffect(() => {
    if (isLaunchOpen) {
      const container = drawerRef.current
      if (container) {
        const first = container.querySelector<HTMLElement>(
          'select, textarea, button:not([data-testid="close-drawer-btn"])'
        )
        if (first) {
          first.focus()
        } else {
          container.querySelector<HTMLElement>('#launch-prompt')?.focus()
        }
      }
    }
  }, [isLaunchOpen])

  // Handle focus trapping in the drawer
  const handleDrawerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab') return
    const container = drawerRef.current
    if (!container) return
    const focusables = Array.from(container.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    ))
    if (focusables.length === 0) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    if (!first || !last) return
    if (e.shiftKey) {
      if (document.activeElement === first) {
        last.focus()
        e.preventDefault()
      }
    } else {
      if (document.activeElement === last) {
        first.focus()
        e.preventDefault()
      }
    }
  }

  // Handle successful launch (close drawer & focus new card)
  useEffect(() => {
    const form = formRef.current
    if (!form) return
    const handleSuccess = () => {
      // Capture focus-eligibility BEFORE the drawer closes and steals focus itself —
      // otherwise activeElement would always read as something inside the (about
      // to be hidden) drawer by the time the timeout fires.
      const submitBtn = form.querySelector('[type="submit"]')
      const focusWasOnLaunchAffordance =
        document.activeElement === submitBtn || document.activeElement === triggerBtnRef.current
      setIsLaunchOpen(false)
      setTimeout(() => {
        // Focus-steal guard: only move focus to the new card if the operator
        // hasn't already moved on to something else since submitting.
        if (!focusWasOnLaunchAffordance) return
        const topCard = document.querySelector('[data-role="run-index-list"] [data-testid="run-card"]') as HTMLElement | null
        if (topCard) {
          topCard.focus()
        } else {
          triggerBtnRef.current?.focus()
        }
      }, 50)
    }
    form.addEventListener('launch-success', handleSuccess)
    return () => form.removeEventListener('launch-success', handleSuccess)
  }, [state])

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
          className="operator-fixture-indicator"
        >
          <span aria-hidden="true">⚠</span>
          <span>Local fixture mode — all data is synthetic</span>
        </div>
      )}
      <div className="operator-header-container">
        <div className="operator-header-main">
          <h1 className="operator-headline">
            {headline}
          </h1>

          <div
            aria-live="polite"
            aria-atomic="true"
            data-testid="operator-status-region"
            className="operator-status-region"
          >
            <p>{detail}</p>
            {recoveryHint.length > 0 && (
              <p className="operator-recovery-hint">{recoveryHint}</p>
            )}
          </div>
        </div>

        {state === 'ready' && (
          <button
            type="button"
            ref={triggerBtnRef}
            data-testid="launch-trigger-btn"
            className="operator-primary-action operator-launch-trigger"
            onClick={() => setIsLaunchOpen(true)}
          >
            <span className="operator-btn-icon" aria-hidden="true">⚡</span>
            <span>Launch Run</span>
          </button>
        )}
      </div>

      {actionsDisabled && actionReason !== null && (
        <div
          data-testid="operator-action-reason"
          role="status"
          className={`operator-warning-panel operator-failure-state-${state}`}
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
            <h2 className="operator-section-heading">
              Recent Runs
            </h2>

            <div
              data-role="run-index-loading"
              aria-live="polite"
              aria-atomic="true"
              aria-label="Recent runs loading"
              className="operator-status-text run-index-skeleton-container"
            >
            <div className="run-card-skeleton" data-testid="run-card-skeleton">
              <span className="skeleton-item skeleton-pill" aria-hidden="true" />
              <span className="skeleton-item skeleton-repo" aria-hidden="true" />
              <span className="skeleton-item skeleton-time" aria-hidden="true" />
            </div>
            <div className="run-card-skeleton" data-testid="run-card-skeleton">
              <span className="skeleton-item skeleton-pill" aria-hidden="true" />
              <span className="skeleton-item skeleton-repo" aria-hidden="true" />
              <span className="skeleton-item skeleton-time" aria-hidden="true" />
            </div>
            <div className="run-card-skeleton" data-testid="run-card-skeleton">
              <span className="skeleton-item skeleton-pill" aria-hidden="true" />
              <span className="skeleton-item skeleton-repo" aria-hidden="true" />
              <span className="skeleton-item skeleton-time" aria-hidden="true" />
            </div>
            </div>

            <div
              data-role="run-index-list"
              aria-label="Recent run list"
            />

            <div
              data-role="run-index-empty"
              hidden
              className="operator-empty-state"
            >
              <div className="operator-empty-icon" aria-hidden="true"></div>
              <p className="operator-empty-title">Ready to launch</p>
              <p className="operator-empty-desc">Describe a task to deploy an operator instance.</p>
            </div>

            <div
              data-role="run-index-unavailable"
              hidden
              className="operator-status-text"
            />

            <div
              data-role="stream-status"
              role="status"
              aria-live="polite"
              hidden
              className="operator-stream-status"
            />
          </section>

          {/* Persistent Launch Drawer */}
          <div
            ref={drawerRef}
            data-testid="launch-drawer"
            className={`operator-drawer-container ${isLaunchOpen ? 'open' : ''}`}
            onKeyDown={handleDrawerKeyDown}
            style={{ display: isLaunchOpen ? 'block' : 'none' }}
          >
            {/* Backdrop */}
            <div
              className="operator-drawer-backdrop"
              onClick={closeDrawer}
            />

            {/* Panel */}
            <div
              className="operator-drawer-panel"
              role="dialog"
              aria-modal="true"
              aria-labelledby="drawer-title"
            >
              <div className="operator-drawer-header">
                <h2 id="drawer-title" className="operator-section-heading" style={{ marginBottom: 0 }}>
                  Launch Run
                </h2>
                <button
                  type="button"
                  data-testid="close-drawer-btn"
                  className="operator-drawer-close"
                  onClick={closeDrawer}
                  aria-label="Close launch panel"
                >
                  ✕
                </button>
              </div>

              <div className="operator-drawer-body">
                {fixtureMode === true && (
                  <div className="operator-form-group">
                    <label
                      htmlFor="fixture-scenario-select"
                      className="operator-label"
                    >
                      Fixture scenario
                    </label>
                    <select
                      id="fixture-scenario-select"
                      data-testid="fixture-scenario-select"
                      className="operator-input operator-select-inline"
                      value={scenario}
                      onChange={e => { setScenario(e.target.value) }}
                    >
                      <option value="success">Success</option>
                      <option value="terminal_failure">Terminal failure</option>
                      <option value="terminal_failure_known_reason">Terminal failure, known reason</option>
                      <option value="terminal_failure_unknown_reason">Terminal failure, unknown reason</option>
                      <option value="non_failed_with_reason">Non-failed with ignored reason</option>
                      <option value="contract_drift">Contract drift</option>
                      <option value="malformed_unavailable">Malformed / unavailable</option>
                      <option value="no_output">No output</option>
                      <option value="stream_reset">Stream reset</option>
                      <option value="approval_flow">Approval flow</option>
                    </select>
                  </div>
                )}

                <div
                  id="repo-picker-container"
                  className="operator-form-group"
                />

                <form id="launch-form" ref={formRef} className="operator-form">
                  <label
                    htmlFor="launch-prompt"
                    className="operator-label"
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
                    className="operator-launch-error"
                  />
                  <button
                    type="submit"
                    className="operator-primary-action operator-submit-btn"
                  >
                    Launch
                  </button>
                </form>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
